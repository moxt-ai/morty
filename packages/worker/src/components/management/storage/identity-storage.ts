import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { and, eq, exists, gt, inArray, isNull, max, ne, notExists, or, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as v from "valibot";
import {
    browserCredential,
    browserDevice,
    continueLink,
    ownerCredential,
} from "../../../schema/computer-relay-do/index.ts";
import type { Credential, SharedLinkTerms } from "../entity/authentication/credential.ts";
import type { ClientLocation } from "../entity/client-location.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, requireIdentityDatabase } from "./identity-storage-common.ts";

type IdentityDatabase = ReturnType<typeof requireIdentityDatabase>;

/** A link no device has used yet: it issued no credential. */
function unusedLink(database: IdentityDatabase, linkId: SQLiteColumn = continueLink.id) {
    return notExists(
        database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(eq(browserCredential.transferId, linkId)),
    );
}
const openedCredential = alias(browserCredential, "opened_credential");
const openedLink = alias(continueLink, "opened_link");
const successorLink = alias(continueLink, "successor_link");
const predecessorLink = alias(continueLink, "predecessor_link");

/**
 * The one rule for a link the owner still stands by: they did not cancel it, no newer link replaced it, and it is
 * not past the time it can add a device. What follows from the access that shared it is read from that access.
 */
function linkInForce(
    database: IdentityDatabase,
    now: number,
    link: {
        readonly id: SQLiteColumn;
        readonly cancelledAt: SQLiteColumn;
        readonly expiresAt: SQLiteColumn;
    } = continueLink,
) {
    return and(
        isNull(link.cancelledAt),
        gt(link.expiresAt, now),
        notExists(
            database
                .select({ id: successorLink.id })
                .from(successorLink)
                .where(eq(successorLink.replacesTransferId, link.id)),
        ),
    );
}

/** Cancels the invitations of the user's links no device has used yet; a cancelled link stays cancelled. */
function cancelUnusedLinks(database: IdentityDatabase, userId: string, now: number) {
    return database
        .update(continueLink)
        .set({ cancelledAt: now })
        .where(and(eq(continueLink.userId, userId), isNull(continueLink.cancelledAt), unusedLink(database)));
}
const successorCredential = alias(ownerCredential, "successor_credential");
const heldDevice = alias(browserDevice, "held_device");

/**
 * A browser device's term: the latest among the links the device opened, so opening another link never shortens it.
 * Null only for a device that opened none.
 */
function deviceTerm(database: IdentityDatabase, deviceId: SQLiteColumn) {
    return sql<number | null>`(${database
        .select({ term: max(openedLink.accessExpiresAt) })
        .from(openedCredential)
        .innerJoin(openedLink, eq(openedLink.id, openedCredential.transferId))
        .where(eq(openedCredential.deviceId, deviceId))})`;
}

/**
 * The one rule for a browser device's access: it holds until its term unless it was ended first, and ended access
 * never resumes. Revoking a link only stops it from adding a device; it never ends a device's access. The value is
 * the term while the device holds access and null once it does not, so every reader and writer applies this rule.
 */
function deviceAccessHeldUntil(
    database: IdentityDatabase,
    device: { readonly id: SQLiteColumn; readonly endedAt: SQLiteColumn },
    now: number,
) {
    const term = deviceTerm(database, device.id);
    return sql<number | null>`(CASE WHEN ${device.endedAt} IS NULL AND ${term} > ${now} THEN ${term} END)`;
}

/** The browser credential's device holds access; replacing the credential keeps the device and its access. */
function browserAccessHeld(database: IdentityDatabase, now: number) {
    return exists(
        database
            .select({ id: heldDevice.id })
            .from(heldDevice)
            .where(
                and(
                    eq(heldDevice.id, browserCredential.deviceId),
                    eq(heldDevice.userId, browserCredential.userId),
                    sql`${deviceAccessHeldUntil(database, heldDevice, now)} IS NOT NULL`,
                ),
            ),
    );
}

/** A browser credential that authenticates now: no newer credential of its device replaced it, and the device holds. */
function browserCredentialInForce(database: IdentityDatabase, now: number) {
    return and(isNull(browserCredential.replacedAt), browserAccessHeld(database, now));
}

/** The one rule for the machine's own and recovery credentials: each holds its own access until it is revoked. */
function ownerAccessHeld(credential: { readonly revokedAt: SQLiteColumn } = ownerCredential) {
    return isNull(credential.revokedAt);
}

/** Ends the access of the matching browser devices whose access has not ended yet; ended access stays ended. */
function endDevices(database: IdentityDatabase, devices: SQL | undefined, now: number) {
    return database
        .update(browserDevice)
        .set({ endedAt: now })
        .where(and(devices, isNull(browserDevice.endedAt)));
}

/** How a browser joining through a link describes itself, and roughly where Cloudflare saw it connect from. */
export interface JoiningDevice {
    readonly label: string | null;
    readonly location: ClientLocation | null;
}

export interface IdentityTransfer extends SharedLinkTerms {
    readonly code: string;
}

/**
 * A credential of the computer's owner as it stands now. The machine's own and recovery credentials hold their own
 * access or were revoked; a browser credential holds its device's access until its device's term, unless a newer
 * credential of the device replaced it or the device's access ended.
 */
export type StoredCredential = { readonly credentialId: string; readonly userId: string } & (
    | { readonly kind: "local" | "recovery"; readonly held: boolean }
    | {
          readonly kind: "browser";
          readonly transferId: string;
          readonly deviceId: string;
          readonly replaced: boolean;
          /** The device's term while it holds access; null once its access ended. */
          readonly accessHeldUntil: number | null;
      }
);

export class IdentityStorage {
    readonly #database: unknown;
    readonly #computerId: string | null;
    readonly #ownerUserId: string | null;

    constructor(database: unknown, computerId: string | null, ownerUserId: string | null) {
        this.#database = database;
        this.#computerId = computerId;
        this.#ownerUserId = ownerUserId;
    }

    readonly createAnonymous = async (
        userId: string,
        computerId: string,
        now: number,
        signal: AbortSignal,
        token: string,
    ): Promise<AnonymousIdentity | null> => {
        signal.throwIfAborted();
        if (userId !== this.#ownerUserId || computerId !== this.#computerId) {
            return null;
        }
        const credentialId = `cred_${crypto.randomUUID()}`;
        const tokenHash = await digest(token);
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        await database
            .insert(ownerCredential)
            .values({ id: credentialId, userId, tokenHash, kind: "local", createdAt: now })
            .onConflictDoNothing({ target: ownerCredential.tokenHash })
            .run();
        signal.throwIfAborted();
        // A retry reuses the committed row, including its revocation; it never resets or replaces it.
        const credential = await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(
                and(
                    eq(ownerCredential.tokenHash, tokenHash),
                    eq(ownerCredential.userId, userId),
                    eq(ownerCredential.kind, "local"),
                    ownerAccessHeld(),
                ),
            )
            .get();
        signal.throwIfAborted();
        return credential === undefined ? null : { token, userId, computerId };
    };

    /**
     * The owner's credential this token authenticates as, as it stands at `now`; null for any other token. The machine's
     * own and recovery credentials are read first, so the credential its holder chose as the successor is that one.
     */
    readonly findCredential = async (
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<StoredCredential | null> => {
        if (this.#computerId === null || this.#ownerUserId === null) {
            return null;
        }
        signal.throwIfAborted();
        const tokenHash = await digest(token);
        const database = requireIdentityDatabase(this.#database);
        const owner = await database
            .select({
                credentialId: ownerCredential.id,
                userId: ownerCredential.userId,
                kind: ownerCredential.kind,
                held: sql<number>`CASE WHEN ${ownerAccessHeld()} THEN 1 ELSE 0 END`.as("held"),
            })
            .from(ownerCredential)
            .where(and(eq(ownerCredential.tokenHash, tokenHash), eq(ownerCredential.userId, this.#ownerUserId)))
            .get();
        signal.throwIfAborted();
        if (owner !== undefined) {
            return { credentialId: owner.credentialId, userId: owner.userId, kind: owner.kind, held: owner.held === 1 };
        }
        const browser = await database
            .select({
                credentialId: browserCredential.id,
                userId: browserCredential.userId,
                transferId: browserCredential.transferId,
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserCredential.deviceId}`.as("credential_device_id"),
                replacedAt: browserCredential.replacedAt,
                accessHeldUntil: deviceAccessHeldUntil(database, browserDevice, now).as("access_held_until"),
            })
            .from(browserCredential)
            .innerJoin(
                browserDevice,
                and(
                    eq(browserDevice.id, browserCredential.deviceId),
                    eq(browserDevice.userId, browserCredential.userId),
                ),
            )
            .where(and(eq(browserCredential.tokenHash, tokenHash), eq(browserCredential.userId, this.#ownerUserId)))
            .get();
        signal.throwIfAborted();
        if (browser === undefined) {
            return null;
        }
        return {
            kind: "browser",
            credentialId: browser.credentialId,
            userId: browser.userId,
            transferId: browser.transferId,
            deviceId: browser.deviceId,
            replaced: browser.replacedAt !== null,
            accessHeldUntil: browser.accessHeldUntil,
        };
    };

    /**
     * Whether the access a Session credential carries holds at `now`: its browser device's, or the machine's own or a
     * recovery credential's. Only the computer owner's access holds.
     */
    readonly holdsAccess = async (holder: SessionAccessHolder, now: number, signal: AbortSignal): Promise<boolean> => {
        if (this.#computerId === null || this.#ownerUserId === null) {
            return false;
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const found =
            holder.kind === "device"
                ? await database
                      .select({ id: browserDevice.id })
                      .from(browserDevice)
                      .where(
                          and(
                              eq(browserDevice.id, holder.deviceId),
                              eq(browserDevice.userId, this.#ownerUserId),
                              sql`${deviceAccessHeldUntil(database, browserDevice, now)} IS NOT NULL`,
                          ),
                      )
                      .get()
                : await database
                      .select({ id: ownerCredential.id })
                      .from(ownerCredential)
                      .where(
                          and(
                              eq(ownerCredential.id, holder.credentialId),
                              eq(ownerCredential.userId, this.#ownerUserId),
                              ownerAccessHeld(),
                          ),
                      )
                      .get();
        signal.throwIfAborted();
        return found !== undefined;
    };

    /**
     * The user's browser devices that hold access at `now`: each described by its first joining, with its term and who
     * shared the link it joined through.
     */
    readonly linkedDevices = async (userId: string, now: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const joinedThrough = alias(continueLink, "joined_through_link");
        const sharerOwner = alias(ownerCredential, "sharer_owner_credential");
        const sharerBrowser = alias(browserCredential, "sharer_browser_credential");
        const sharerDevice = alias(browserDevice, "sharer_device");
        const accessHeldUntil = deviceAccessHeldUntil(database, browserDevice, now);
        const rows = await database
            .select({
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserDevice.id}`.as("device_id"),
                joinedAt: browserDevice.joinedAt,
                label: browserDevice.label,
                joinedCity: browserDevice.joinedCity,
                joinedCountry: browserDevice.joinedCountry,
                accessHeldUntil: accessHeldUntil.as("access_held_until"),
                sharerKind: sql<
                    Credential["kind"] | null
                >`coalesce(${sharerOwner.kind}, CASE WHEN ${sharerBrowser.id} IS NOT NULL THEN 'browser' END)`.as(
                    "sharer_kind",
                ),
                sharerLabel: sql<string | null>`${sharerDevice.label}`.as("sharer_label"),
            })
            .from(browserDevice)
            .leftJoin(joinedThrough, eq(joinedThrough.id, browserDevice.joinedThroughTransferId))
            .leftJoin(sharerOwner, eq(sharerOwner.id, joinedThrough.createdByCredentialId))
            .leftJoin(sharerBrowser, eq(sharerBrowser.id, joinedThrough.createdByCredentialId))
            .leftJoin(sharerDevice, eq(sharerDevice.id, sharerBrowser.deviceId))
            // Ended access never resumes; reading only the devices that hold access keeps the list short.
            .where(and(eq(browserDevice.userId, userId), sql`${accessHeldUntil} IS NOT NULL`))
            .all();
        signal.throwIfAborted();
        return rows;
    };

    /**
     * Revokes every local and recovery credential except the caller's, ends every browser device's access, and cancels
     * the links no device has used yet. Only the machine's own credential, which belongs to no device, may do this.
     */
    readonly revokeOtherAccess = async (
        userId: string,
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const tokenHash = await digest(token);
        await database.batch([
            cancelUnusedLinks(database, userId, now),
            database
                .update(ownerCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(ownerCredential.userId, userId),
                        ne(ownerCredential.tokenHash, tokenHash),
                        ownerAccessHeld(),
                    ),
                ),
            endDevices(database, eq(browserDevice.userId, userId), now),
        ]);
        signal.throwIfAborted();
    };

    /**
     * Revokes every local and recovery credential, the caller's included, and ends every browser device's access, in one
     * transaction that issues `successor` as the only local credential. Every link was shared by access this ends, so
     * none adds a device afterwards. Only
     * the machine's own credential may do this, so a copy of it stops working too. Repeating it with the successor as
     * the caller, after a lost reply, repeats the revocation and keeps the successor. False when the caller no longer
     * holds access, and then nothing changed.
     */
    readonly revokeAllAccess = async (
        userId: string,
        token: string,
        successor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const tokenHash = await digest(token);
        const successorHash = await digest(successor);
        const localCredential = (hash: string) =>
            and(
                eq(ownerCredential.userId, userId),
                eq(ownerCredential.tokenHash, hash),
                eq(ownerCredential.kind, "local"),
                ownerAccessHeld(),
            );
        const successorInForce = exists(
            database
                .select({ id: successorCredential.id })
                .from(successorCredential)
                .where(
                    and(
                        eq(successorCredential.userId, userId),
                        eq(successorCredential.tokenHash, successorHash),
                        eq(successorCredential.kind, "local"),
                        ownerAccessHeld(successorCredential),
                    ),
                ),
        );
        await database.batch([
            database
                .insert(ownerCredential)
                .select(
                    database
                        .select({
                            id: sql<string>`${`cred_${crypto.randomUUID()}`}`.as("id"),
                            userId: ownerCredential.userId,
                            tokenHash: sql<string>`${successorHash}`.as("token_hash"),
                            kind: sql<"local">`'local'`.as("kind"),
                            createdAt: sql<number>`${now}`.as("created_at"),
                            revokedAt: sql<null>`null`.as("revoked_at"),
                        })
                        .from(ownerCredential)
                        .where(localCredential(tokenHash)),
                )
                .onConflictDoNothing({ target: ownerCredential.tokenHash }),
            // Nothing else changes unless the successor holds access: a caller revoked meanwhile revokes nothing.
            database
                .update(ownerCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(ownerCredential.userId, userId),
                        ne(ownerCredential.tokenHash, successorHash),
                        ownerAccessHeld(),
                        successorInForce,
                    ),
                ),
            endDevices(database, and(eq(browserDevice.userId, userId), successorInForce), now),
        ]);
        const rotated = await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(localCredential(successorHash))
            .get();
        signal.throwIfAborted();
        return rotated !== undefined;
    };

    /**
     * Ends the access of every browser device except the one kept, and cancels the links no device has used yet. The
     * machine's own and recovery credentials belong to no device, so they stay.
     */
    readonly endOtherBrowserAccess = async (
        userId: string,
        keptDeviceId: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        await database.batch([
            cancelUnusedLinks(database, userId, now),
            endDevices(
                database,
                and(
                    eq(browserDevice.userId, userId),
                    keptDeviceId === null ? undefined : ne(browserDevice.id, keptDeviceId),
                ),
                now,
            ),
        ]);
        signal.throwIfAborted();
    };

    /** Claims an unopened predecessor and issues its successor atomically; retries read the committed issuance. */
    readonly createTransfer = async (
        userId: string,
        parentToken: string,
        now: number,
        terms: SharedLinkTerms,
        replaces: string | null,
        operation: { readonly code: string; readonly requestHash: string },
        signal: AbortSignal,
    ): Promise<
        | {
              readonly kind: "issued";
              readonly createdAt: number;
              readonly expiresAt: number;
              readonly accessExpiresAt: number;
          }
        | { readonly kind: "conflict" }
    > => {
        signal.throwIfAborted();
        // Check the issuing credential in the write itself so ending its access cannot race issuance.
        const database = requireIdentityDatabase(this.#database);
        const parentTokenHash = await digest(parentToken);
        const codeHash = await digest(operation.code);
        const replacesHash = replaces === null ? null : await digest(replaces);
        const ownerIssuer = and(
            eq(ownerCredential.userId, userId),
            eq(ownerCredential.tokenHash, parentTokenHash),
            ownerAccessHeld(),
        );
        const browserIssuer = and(
            eq(browserCredential.userId, userId),
            eq(browserCredential.tokenHash, parentTokenHash),
            browserCredentialInForce(database, now),
        );
        const createdByIssuer = (createdBy: SQLiteColumn) =>
            or(
                inArray(
                    createdBy,
                    database.select({ id: ownerCredential.id }).from(ownerCredential).where(ownerIssuer),
                ),
                inArray(
                    createdBy,
                    database.select({ id: browserCredential.id }).from(browserCredential).where(browserIssuer),
                ),
            );
        // The unused link the issuer shared before and this one replaces; replacing it is recorded on this link alone.
        const predecessor = and(
            eq(predecessorLink.codeHash, replacesHash ?? ""),
            eq(predecessorLink.userId, userId),
            linkInForce(database, now, predecessorLink),
            unusedLink(database, predecessorLink.id),
            createdByIssuer(predecessorLink.createdByCredentialId),
        );
        const predecessorId = database.select({ id: predecessorLink.id }).from(predecessorLink).where(predecessor);
        const predecessorOpen = replacesHash === null ? undefined : exists(predecessorId);
        // The link's columns in table order, issued by `issuer`.
        const issuedBy = (issuer: { readonly id: SQLiteColumn; readonly userId: SQLiteColumn }) => ({
            id: sql<string>`${`transfer_${crypto.randomUUID()}`}`.as("id"),
            codeHash: sql<string>`${codeHash}`.as("code_hash"),
            requestHash: sql<string>`${operation.requestHash}`.as("request_hash"),
            userId: issuer.userId,
            expiresAt: sql<number>`${terms.expiresAt}`.as("expires_at"),
            accessExpiresAt: sql<number>`${terms.accessExpiresAt}`.as("access_expires_at"),
            createdAt: sql<number>`${now}`.as("created_at"),
            createdByCredentialId: issuer.id,
            replacesTransferId: (replacesHash === null ? sql<null>`null` : sql<string>`(${predecessorId})`).as(
                "replaces_transfer_id",
            ),
            cancelledAt: sql<null>`null`.as("cancelled_at"),
        });
        // The token names one credential, of one kind, so at most one of these issues the link.
        const issueByOwner = database
            .insert(continueLink)
            .select(
                database
                    .select(issuedBy(ownerCredential))
                    .from(ownerCredential)
                    .where(and(ownerIssuer, predecessorOpen)),
            )
            .onConflictDoNothing({ target: continueLink.codeHash });
        const issueByBrowser = database
            .insert(continueLink)
            .select(
                database
                    .select(issuedBy(browserCredential))
                    .from(browserCredential)
                    .where(and(browserIssuer, predecessorOpen)),
            )
            .onConflictDoNothing({ target: continueLink.codeHash });
        signal.throwIfAborted();
        await database.batch([issueByOwner, issueByBrowser]);
        const issued = await database
            .select({
                createdAt: continueLink.createdAt,
                expiresAt: continueLink.expiresAt,
                accessExpiresAt: continueLink.accessExpiresAt,
            })
            .from(continueLink)
            .where(
                and(
                    eq(continueLink.codeHash, codeHash),
                    eq(continueLink.requestHash, operation.requestHash),
                    eq(continueLink.userId, userId),
                    linkInForce(database, now),
                    createdByIssuer(continueLink.createdByCredentialId),
                ),
            )
            .get();
        signal.throwIfAborted();
        return issued === undefined ? { kind: "conflict" } : { kind: "issued", ...issued };
    };

    /** Issues a recovery credential while the machine's own credential that asks for it holds access. */
    readonly createRecoveryToken = async (
        userId: string,
        parentToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<string | null> => {
        signal.throwIfAborted();
        const token = createProjectCredential("morty_recovery_v1", v.parse(v.string(), this.#computerId));
        const database = requireIdentityDatabase(this.#database);
        const result = await database
            .insert(ownerCredential)
            .select(
                database
                    .select({
                        id: sql<string>`${`cred_${crypto.randomUUID()}`}`.as("id"),
                        userId: ownerCredential.userId,
                        tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                        kind: sql<"recovery">`'recovery'`.as("kind"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
                    })
                    .from(ownerCredential)
                    .where(
                        and(
                            eq(ownerCredential.userId, userId),
                            eq(ownerCredential.tokenHash, await digest(parentToken)),
                            eq(ownerCredential.kind, "local"),
                            ownerAccessHeld(),
                        ),
                    ),
            )
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1 ? token : null;
    };

    /**
     * Opens a link in a browser. `replaces` is the credential the browser already holds for this Project: a browser
     * keeps one credential, so the new one replaces it at once and belongs to the same device while that device still
     * holds access; the device keeps the later of its term and this link's. A browser holding none, or whose device's
     * access ended, becomes a new device, described by this joining.
     *
     * `token` is the credential this redemption issues. A link issues one credential, so repeating the redemption that
     * used it, with the same token, returns that credential while it still holds access instead of refusing the browser
     * whose first reply was lost; it never issues another.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        joining: JoiningDevice,
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => {
        const parsed = readProjectCredential(code);
        if (parsed?.kind !== "morty_transfer_v1" || parsed.computerId !== this.#computerId) {
            return null;
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const codeHash = await digest(code);
        const credentialId = `cred_${crypto.randomUUID()}`;
        const newDeviceId = `device_${crypto.randomUUID()}`;
        // A link adds one device: only while no credential was issued through it.
        const open = and(
            eq(continueLink.codeHash, codeHash),
            linkInForce(database, now),
            gt(continueLink.accessExpiresAt, now),
            unusedLink(database),
            // A link adds no device once the access that shared it ended; checking it in the issuing write means ending
            // that access needs no separate write to void the link. Renewal replaces a credential without ending its
            // access, so invitations survive it.
            or(
                exists(
                    database
                        .select({ id: ownerCredential.id })
                        .from(ownerCredential)
                        .where(
                            and(
                                eq(ownerCredential.id, continueLink.createdByCredentialId),
                                eq(ownerCredential.userId, continueLink.userId),
                                ownerAccessHeld(),
                            ),
                        ),
                ),
                exists(
                    database
                        .select({ id: browserCredential.id })
                        .from(browserCredential)
                        .where(
                            and(
                                eq(browserCredential.id, continueLink.createdByCredentialId),
                                eq(browserCredential.userId, continueLink.userId),
                                browserAccessHeld(database, now),
                            ),
                        ),
                ),
            ),
        );
        const replacedHash = replaces === null ? null : await digest(replaces);
        const tokenHash = await digest(token);
        // Only a browser credential of the link's own user names the device.
        const replaced = and(
            eq(browserCredential.tokenHash, replacedHash ?? ""),
            inArray(
                browserCredential.userId,
                database
                    .select({ userId: continueLink.userId })
                    .from(continueLink)
                    .where(eq(continueLink.codeHash, codeHash)),
            ),
        );
        // The replaced credential may already be replaced by a concurrent or retried redemption in the same browser;
        // the device it belongs to is kept while that device holds access. The read and the writes below run with no
        // other request in between: the Project's Durable Object runs its SQL synchronously.
        const kept =
            replacedHash === null
                ? undefined
                : await database
                      .select({ id: browserDevice.id })
                      .from(browserDevice)
                      .innerJoin(
                          browserCredential,
                          and(
                              eq(browserCredential.deviceId, browserDevice.id),
                              eq(browserCredential.userId, browserDevice.userId),
                          ),
                      )
                      .where(and(replaced, sql`${deviceAccessHeldUntil(database, browserDevice, now)} IS NOT NULL`))
                      .get();
        const deviceId = kept?.id ?? newDeviceId;
        const issued = database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(eq(browserCredential.id, credentialId));
        const issue = database.insert(browserCredential).select(
            database
                .select({
                    id: sql<string>`${credentialId}`.as("id"),
                    userId: continueLink.userId,
                    tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
                    deviceId: sql<string>`${deviceId}`.as("device_id"),
                    transferId: continueLink.id,
                    createdAt: sql<number>`${now}`.as("created_at"),
                    replacedAt: sql<null>`null`.as("replaced_at"),
                })
                .from(continueLink)
                .where(open),
        );
        const describe = database.insert(browserDevice).select(
            database
                .select({
                    id: sql<string>`${newDeviceId}`.as("id"),
                    userId: browserCredential.userId,
                    joinedAt: sql<number>`${now}`.as("joined_at"),
                    label: sql<string | null>`${joining.label}`.as("label"),
                    joinedCity: sql<string | null>`${joining.location?.city ?? null}`.as("joined_city"),
                    joinedCountry: sql<string | null>`${joining.location?.country ?? null}`.as("joined_country"),
                    joinedThroughTransferId: browserCredential.transferId,
                    endedAt: sql<null>`null`.as("ended_at"),
                })
                .from(browserCredential)
                .where(and(eq(browserCredential.id, credentialId), eq(browserCredential.deviceId, newDeviceId))),
        );
        await database.batch([
            issue,
            describe,
            // Only a credential of the device the new one joins is replaced; one whose device's access ended stays as
            // it was, ended with its device.
            database
                .update(browserCredential)
                .set({ replacedAt: now })
                .where(
                    and(
                        replaced,
                        eq(browserCredential.deviceId, deviceId),
                        isNull(browserCredential.replacedAt),
                        exists(issued),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        // Issued just now, or by an earlier attempt of this redemption whose reply was lost, while it still grants its
        // device's access.
        const issuedThroughLink = await database
            .select({ userId: browserCredential.userId })
            .from(browserCredential)
            .innerJoin(continueLink, eq(continueLink.id, browserCredential.transferId))
            .where(
                and(
                    eq(browserCredential.tokenHash, tokenHash),
                    eq(continueLink.codeHash, codeHash),
                    browserCredentialInForce(database, now),
                ),
            )
            .get();
        signal.throwIfAborted();
        return issuedThroughLink === undefined
            ? null
            : { token, userId: issuedThroughLink.userId, computerId: parsed.computerId };
    };

    readonly revokeCredential = async (
        credential: Exclude<Credential, { readonly kind: "browser" }>,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const revoked = await requireIdentityDatabase(this.#database)
            .update(ownerCredential)
            .set({ revokedAt: now })
            .where(
                and(
                    eq(ownerCredential.id, credential.credentialId),
                    eq(ownerCredential.userId, credential.userId),
                    ownerAccessHeld(),
                ),
            )
            .run();
        signal.throwIfAborted();
        return revoked.meta.changes === 1;
    };

    /**
     * Ends the access of one of the user's browser devices, and with it every credential of that device, including one
     * a retried or concurrent redemption issued; its unused invitations add no device once it ended. Returns false when
     * the user has no such device; a device whose access already ended stays ended, so repeating is harmless.
     */
    readonly endDeviceAccess = async (
        userId: string,
        deviceId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const device = and(eq(browserDevice.userId, userId), eq(browserDevice.id, deviceId));
        const found = await database.select({ id: browserDevice.id }).from(browserDevice).where(device).get();
        if (found === undefined) {
            signal.throwIfAborted();
            return false;
        }
        await endDevices(database, device, now).run();
        signal.throwIfAborted();
        return true;
    };

    readonly ownsProject = async (userId: string, computerId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        if (this.#computerId !== computerId) {
            return false;
        }
        return userId === this.#ownerUserId;
    };
}
