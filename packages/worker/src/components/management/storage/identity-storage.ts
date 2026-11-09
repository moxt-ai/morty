import { and, eq, exists, gt, inArray, isNotNull, isNull, max, ne, notExists, or, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as v from "valibot";
import { anonymousCredential, browserDevice, continueLink, managedBot } from "../../../schema/project-do/index.ts";
import { type Credential, deviceAccess, type SharedLinkTerms } from "../entity/authentication/credential.ts";
import type { ClientLocation } from "../entity/client-location.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, requireIdentityDatabase } from "./identity-storage-common.ts";

type IdentityDatabase = ReturnType<typeof requireIdentityDatabase>;

/** A link no device has used yet: it issued no credential. */
function unusedLink(database: IdentityDatabase) {
    return notExists(
        database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(eq(anonymousCredential.remoteTransferId, continueLink.id)),
    );
}
const openedCredential = alias(anonymousCredential, "opened_credential");
const openedLink = alias(continueLink, "opened_link");
const successorCredential = alias(anonymousCredential, "successor_credential");

/**
 * A browser device's term: the latest among the links the device opened, so opening another link never shortens it.
 * Null only for a device that opened none. The device holds access until then unless it was ended (`deviceAccess`).
 */
function deviceAccessExpiresAt(database: IdentityDatabase, deviceId: SQLiteColumn) {
    return sql<number | null>`(${database
        .select({ term: max(openedLink.accessExpiresAt) })
        .from(openedCredential)
        .innerJoin(openedLink, eq(openedLink.id, openedCredential.remoteTransferId))
        .where(eq(openedCredential.deviceId, deviceId))})`;
}

/** Credential replacement keeps the same device; ending that device's access reaches all of its credentials. */
function credentialDeviceNotEnded(database: IdentityDatabase) {
    return or(
        isNull(anonymousCredential.deviceId),
        inArray(
            anonymousCredential.deviceId,
            database
                .select({ id: browserDevice.id })
                .from(browserDevice)
                .where(and(eq(browserDevice.userId, anonymousCredential.userId), isNull(browserDevice.endedAt))),
        ),
    );
}

/** A credential that authenticates now, apart from its device's term. */
function credentialInForce(database: IdentityDatabase) {
    return and(
        isNull(anonymousCredential.revokedAt),
        isNull(anonymousCredential.replacedAt),
        credentialDeviceNotEnded(database),
    );
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

export class IdentityStorage {
    readonly #database: unknown;
    readonly #computerId: string | null;

    constructor(database: unknown, computerId: string | null = null) {
        this.#database = database;
        this.#computerId = computerId;
    }

    readonly createAnonymous = async (
        userId: string,
        computerId: string,
        now: number,
        signal: AbortSignal,
        token: string,
    ): Promise<AnonymousIdentity | null> => {
        signal.throwIfAborted();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const tokenHash = await digest(token);
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        await database
            .insert(anonymousCredential)
            .values({
                id: credentialId,
                userId,
                tokenHash,
                kind: "local",
                createdAt: now,
            })
            .onConflictDoNothing({ target: anonymousCredential.tokenHash })
            .run();
        signal.throwIfAborted();
        // A retry reuses the committed row, including its revocation; it never resets or replaces it.
        const credential = await database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(
                and(
                    eq(anonymousCredential.tokenHash, tokenHash),
                    eq(anonymousCredential.userId, userId),
                    eq(anonymousCredential.kind, "local"),
                    isNull(anonymousCredential.revokedAt),
                ),
            )
            .get();
        signal.throwIfAborted();
        return credential === undefined ? null : { token, userId, computerId };
    };

    readonly findCredential = async (token: string, signal: AbortSignal) => {
        if (this.#computerId === null) {
            return null;
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const result = await database
            .select({
                credentialId: anonymousCredential.id,
                userId: anonymousCredential.userId,
                kind: anonymousCredential.kind,
                transferId: anonymousCredential.remoteTransferId,
                deviceId: anonymousCredential.deviceId,
                revokedAt: anonymousCredential.revokedAt,
                replacedAt: anonymousCredential.replacedAt,
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                // A local or recovery credential belongs to no device, which has no record, end or term.
                recordedDeviceId: sql<string | null>`${browserDevice.id}`.as("recorded_device_id"),
                deviceEndedAt: sql<number | null>`${browserDevice.endedAt}`.as("device_ended_at"),
                accessExpiresAt: deviceAccessExpiresAt(database, anonymousCredential.deviceId).as(
                    "device_access_expires_at",
                ),
            })
            .from(anonymousCredential)
            .innerJoin(managedBot, eq(managedBot.userId, anonymousCredential.userId))
            .leftJoin(
                browserDevice,
                and(
                    eq(browserDevice.id, anonymousCredential.deviceId),
                    eq(browserDevice.userId, anonymousCredential.userId),
                ),
            )
            .where(eq(anonymousCredential.tokenHash, await digest(token)))
            .get();
        signal.throwIfAborted();
        return result ?? null;
    };

    /**
     * The user's browser devices whose access was not ended, so the caller can apply the access rule: a device
     * described by its first joining, its term, and who shared the link it joined through.
     */
    readonly linkedDevices = async (userId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const joinedThrough = alias(continueLink, "joined_through_link");
        const sharer = alias(anonymousCredential, "sharer_credential");
        const sharerDevice = alias(browserDevice, "sharer_device");
        const rows = await database
            .select({
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserDevice.id}`.as("device_id"),
                joinedAt: browserDevice.joinedAt,
                label: browserDevice.label,
                joinedCity: browserDevice.joinedCity,
                joinedCountry: browserDevice.joinedCountry,
                endedAt: sql<number | null>`${browserDevice.endedAt}`.as("ended_at"),
                accessExpiresAt: deviceAccessExpiresAt(database, browserDevice.id).as("access_expires_at"),
                sharerKind: sql<Credential["kind"] | null>`${sharer.kind}`.as("sharer_kind"),
                sharerLabel: sql<string | null>`${sharerDevice.label}`.as("sharer_label"),
            })
            .from(browserDevice)
            .leftJoin(joinedThrough, eq(joinedThrough.id, browserDevice.joinedThroughTransferId))
            .leftJoin(sharer, eq(sharer.id, joinedThrough.createdByCredentialId))
            .leftJoin(sharerDevice, eq(sharerDevice.id, sharer.deviceId))
            // Ended access never resumes; reading only the other devices keeps the list short.
            .where(and(eq(browserDevice.userId, userId), isNull(browserDevice.endedAt)))
            .all();
        signal.throwIfAborted();
        return rows;
    };

    /**
     * Revokes every local and recovery credential except the caller's, ends every browser device's access, and voids
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
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(and(eq(continueLink.userId, userId), isNull(continueLink.revokedAt), unusedLink(database))),
            database
                .update(anonymousCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.userId, userId),
                        ne(anonymousCredential.kind, "browser"),
                        ne(anonymousCredential.tokenHash, tokenHash),
                        isNull(anonymousCredential.revokedAt),
                    ),
                ),
            endDevices(database, eq(browserDevice.userId, userId), now),
        ]);
        signal.throwIfAborted();
    };

    /**
     * Revokes every local and recovery credential, the caller's included, ends every browser device's access, and voids
     * the links no device has used yet, in one transaction that issues `successor` as the only local credential. Only
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
        const successorInForce = exists(
            database
                .select({ id: successorCredential.id })
                .from(successorCredential)
                .where(
                    and(
                        eq(successorCredential.userId, userId),
                        eq(successorCredential.tokenHash, successorHash),
                        eq(successorCredential.kind, "local"),
                        isNull(successorCredential.revokedAt),
                    ),
                ),
        );
        await database.batch([
            database
                .insert(anonymousCredential)
                .select(
                    database
                        .select({
                            id: sql<string>`${`cred_${crypto.randomUUID()}`}`.as("id"),
                            userId: anonymousCredential.userId,
                            tokenHash: sql<string>`${successorHash}`.as("token_hash"),
                            kind: sql<"local">`'local'`.as("kind"),
                            createdAt: sql<number>`${now}`.as("created_at"),
                            revokedAt: sql<null>`null`.as("revoked_at"),
                            replacedAt: sql<null>`null`.as("replaced_at"),
                            remoteTransferId: sql<null>`null`.as("remote_transfer_id"),
                            deviceId: sql<null>`null`.as("device_id"),
                        })
                        .from(anonymousCredential)
                        .where(
                            and(
                                eq(anonymousCredential.userId, userId),
                                eq(anonymousCredential.tokenHash, tokenHash),
                                eq(anonymousCredential.kind, "local"),
                                isNull(anonymousCredential.revokedAt),
                            ),
                        ),
                )
                .onConflictDoNothing({ target: anonymousCredential.tokenHash }),
            // Nothing else changes unless the successor holds access: a caller revoked meanwhile revokes nothing.
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(continueLink.userId, userId),
                        isNull(continueLink.revokedAt),
                        unusedLink(database),
                        successorInForce,
                    ),
                ),
            database
                .update(anonymousCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.userId, userId),
                        ne(anonymousCredential.kind, "browser"),
                        ne(anonymousCredential.tokenHash, successorHash),
                        isNull(anonymousCredential.revokedAt),
                        successorInForce,
                    ),
                ),
            endDevices(database, and(eq(browserDevice.userId, userId), successorInForce), now),
        ]);
        const rotated = await database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(
                and(
                    eq(anonymousCredential.userId, userId),
                    eq(anonymousCredential.tokenHash, successorHash),
                    eq(anonymousCredential.kind, "local"),
                    isNull(anonymousCredential.revokedAt),
                ),
            )
            .get();
        signal.throwIfAborted();
        return rotated !== undefined;
    };

    /**
     * Ends the access of every browser device except the one kept, and voids the links no device has used yet. The
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
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(and(eq(continueLink.userId, userId), isNull(continueLink.revokedAt), unusedLink(database))),
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

    /**
     * Issues a link, and stops `replaces` from working when it is a link the same access shared that no one opened, so
     * choosing other terms leaves one link to hand out. Both happen in one write with the issuing credential checked.
     */
    readonly createTransfer = async (
        userId: string,
        parentToken: string,
        now: number,
        terms: SharedLinkTerms,
        replaces: string | null,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        signal.throwIfAborted();
        const code = createProjectCredential("morty_transfer_v1", v.parse(v.string(), this.#computerId));
        // Check the issuing credential in the write itself so ending its access cannot race issuance. Its term needs no
        // check here: the terms are capped by it, so a link shared after it ended adds no device.
        const database = requireIdentityDatabase(this.#database);
        const parentTokenHash = await digest(parentToken);
        const issuer = and(
            eq(anonymousCredential.userId, userId),
            eq(anonymousCredential.tokenHash, parentTokenHash),
            credentialInForce(database),
        );
        const issue = database.insert(continueLink).select(
            database
                .select({
                    id: sql<string>`${`transfer_${crypto.randomUUID()}`}`.as("id"),
                    codeHash: sql<string>`${await digest(code)}`.as("code_hash"),
                    userId: anonymousCredential.userId,
                    expiresAt: sql<number>`${terms.expiresAt}`.as("expires_at"),
                    accessExpiresAt: sql<number>`${terms.accessExpiresAt}`.as("access_expires_at"),
                    createdAt: sql<number>`${now}`.as("created_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    createdByCredentialId: anonymousCredential.id,
                })
                .from(anonymousCredential)
                .where(issuer),
        );
        const [issued] =
            replaces === null
                ? [await issue.run()]
                : await database.batch([
                      issue,
                      database
                          .update(continueLink)
                          .set({ revokedAt: now })
                          .where(
                              and(
                                  eq(continueLink.codeHash, await digest(replaces)),
                                  eq(continueLink.userId, userId),
                                  isNull(continueLink.revokedAt),
                                  unusedLink(database),
                                  inArray(
                                      continueLink.createdByCredentialId,
                                      database
                                          .select({ id: anonymousCredential.id })
                                          .from(anonymousCredential)
                                          .where(issuer),
                                  ),
                              ),
                          ),
                  ]);
        signal.throwIfAborted();
        return issued.meta.changes === 1 ? { code, ...terms } : null;
    };

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
            .insert(anonymousCredential)
            .select(
                database
                    .select({
                        id: sql<string>`${`cred_${crypto.randomUUID()}`}`.as("id"),
                        userId: anonymousCredential.userId,
                        tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                        kind: sql<"recovery">`'recovery'`.as("kind"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
                        replacedAt: sql<null>`null`.as("replaced_at"),
                        remoteTransferId: sql<null>`null`.as("remote_transfer_id"),
                        deviceId: sql<null>`null`.as("device_id"),
                    })
                    .from(anonymousCredential)
                    .where(
                        and(
                            eq(anonymousCredential.userId, userId),
                            eq(anonymousCredential.tokenHash, await digest(parentToken)),
                            isNull(anonymousCredential.revokedAt),
                        ),
                    ),
            )
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1 ? token : null;
    };

    /** The device the `replaced` credential belongs to, while that device holds access. */
    readonly #deviceHoldingAccess = async (replaced: SQL | undefined, now: number): Promise<string | null> => {
        const database = requireIdentityDatabase(this.#database);
        const device = await database
            .select({
                id: browserDevice.id,
                endedAt: browserDevice.endedAt,
                accessExpiresAt: deviceAccessExpiresAt(database, browserDevice.id).as("access_expires_at"),
            })
            .from(browserDevice)
            .innerJoin(
                anonymousCredential,
                and(
                    eq(anonymousCredential.deviceId, browserDevice.id),
                    eq(anonymousCredential.userId, browserDevice.userId),
                ),
            )
            .where(replaced)
            .get();
        if (device === undefined) {
            return null;
        }
        const access = deviceAccess(device, now);
        switch (access.kind) {
            case "holding":
                return device.id;
            case "ended":
            case "expired":
                return null;
        }
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
            isNull(continueLink.revokedAt),
            gt(continueLink.expiresAt, now),
            gt(continueLink.accessExpiresAt, now),
            unusedLink(database),
            // Recheck the sharing device in the issuing write. A replaced credential still belongs to that device;
            // using credentialInForce here would invalidate invitations on ordinary credential renewal.
            exists(
                database
                    .select({ id: anonymousCredential.id })
                    .from(anonymousCredential)
                    .where(
                        and(
                            eq(anonymousCredential.id, continueLink.createdByCredentialId),
                            eq(anonymousCredential.userId, continueLink.userId),
                            credentialDeviceNotEnded(database),
                        ),
                    ),
            ),
        );
        const replacedHash = replaces === null ? null : await digest(replaces);
        const tokenHash = await digest(token);
        // Only a browser credential of the link's own user names the device.
        const replaced = and(
            eq(anonymousCredential.tokenHash, replacedHash ?? ""),
            isNotNull(anonymousCredential.deviceId),
            inArray(
                anonymousCredential.userId,
                database
                    .select({ userId: continueLink.userId })
                    .from(continueLink)
                    .where(eq(continueLink.codeHash, codeHash)),
            ),
        );
        // The replaced credential may already be replaced by a concurrent or retried redemption in the same browser;
        // the device it belongs to is kept while that device holds access. The read and the writes below run with no
        // other request in between: the Project's Durable Object runs its SQL synchronously.
        const deviceId =
            replacedHash === null ? newDeviceId : ((await this.#deviceHoldingAccess(replaced, now)) ?? newDeviceId);
        const issued = database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(eq(anonymousCredential.id, credentialId));
        const issue = database.insert(anonymousCredential).select(
            database
                .select({
                    id: sql<string>`${credentialId}`.as("id"),
                    userId: continueLink.userId,
                    tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
                    kind: sql<"browser">`'browser'`.as("kind"),
                    createdAt: sql<number>`${now}`.as("created_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    replacedAt: sql<null>`null`.as("replaced_at"),
                    remoteTransferId: continueLink.id,
                    deviceId: sql<string>`${deviceId}`.as("device_id"),
                })
                .from(continueLink)
                .where(open),
        );
        const describe = database.insert(browserDevice).select(
            database
                .select({
                    id: sql<string>`${newDeviceId}`.as("id"),
                    userId: anonymousCredential.userId,
                    joinedAt: sql<number>`${now}`.as("joined_at"),
                    label: sql<string | null>`${joining.label}`.as("label"),
                    joinedCity: sql<string | null>`${joining.location?.city ?? null}`.as("joined_city"),
                    joinedCountry: sql<string | null>`${joining.location?.country ?? null}`.as("joined_country"),
                    joinedThroughTransferId: anonymousCredential.remoteTransferId,
                    endedAt: sql<null>`null`.as("ended_at"),
                })
                .from(anonymousCredential)
                .where(and(eq(anonymousCredential.id, credentialId), eq(anonymousCredential.deviceId, newDeviceId))),
        );
        await database.batch([
            issue,
            describe,
            // Only a credential of the device the new one joins is replaced; one whose device's access ended stays as
            // it was, ended with its device.
            database
                .update(anonymousCredential)
                .set({ replacedAt: now })
                .where(
                    and(
                        replaced,
                        eq(anonymousCredential.deviceId, deviceId),
                        isNull(anonymousCredential.replacedAt),
                        exists(issued),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        const issuedThroughLink = await database
            .select({
                userId: anonymousCredential.userId,
                replacedAt: anonymousCredential.replacedAt,
                endedAt: browserDevice.endedAt,
                accessExpiresAt: deviceAccessExpiresAt(database, anonymousCredential.deviceId).as(
                    "device_access_expires_at",
                ),
            })
            .from(anonymousCredential)
            .innerJoin(continueLink, eq(continueLink.id, anonymousCredential.remoteTransferId))
            .innerJoin(
                browserDevice,
                and(
                    eq(browserDevice.id, anonymousCredential.deviceId),
                    eq(browserDevice.userId, anonymousCredential.userId),
                ),
            )
            .where(and(eq(anonymousCredential.tokenHash, tokenHash), eq(continueLink.codeHash, codeHash)))
            .get();
        signal.throwIfAborted();
        // Issued just now, or by an earlier attempt of this redemption whose reply was lost, while it still grants its
        // device's access.
        if (
            issuedThroughLink === undefined ||
            issuedThroughLink.replacedAt !== null ||
            deviceAccess(issuedThroughLink, now).kind !== "holding"
        ) {
            return null;
        }
        return { token, userId: issuedThroughLink.userId, computerId: parsed.computerId };
    };

    readonly revokeCredential = async (
        credential: Exclude<Credential, { readonly kind: "browser" }>,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const revoked = await requireIdentityDatabase(this.#database)
            .update(anonymousCredential)
            .set({ revokedAt: now })
            .where(
                and(
                    eq(anonymousCredential.id, credential.credentialId),
                    eq(anonymousCredential.userId, credential.userId),
                    isNull(anonymousCredential.revokedAt),
                ),
            )
            .run();
        signal.throwIfAborted();
        return revoked.meta.changes === 1;
    };

    /**
     * Ends the access of one of the user's browser devices, and with it every credential of that device, including one
     * a retried or concurrent redemption issued, and voids its unused invitations in the same transaction. Returns false
     * when the user has no such device; a device whose access already ended stays ended, so repeating is harmless.
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
        await database.batch([
            endDevices(database, device, now),
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(continueLink.userId, userId),
                        isNull(continueLink.revokedAt),
                        unusedLink(database),
                        inArray(
                            continueLink.createdByCredentialId,
                            database
                                .select({ id: anonymousCredential.id })
                                .from(anonymousCredential)
                                .where(
                                    and(
                                        eq(anonymousCredential.userId, userId),
                                        eq(anonymousCredential.deviceId, deviceId),
                                    ),
                                ),
                        ),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        return true;
    };

    readonly ownsProject = async (userId: string, computerId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        if (this.#computerId !== computerId) {
            return false;
        }
        const row = await requireIdentityDatabase(this.#database)
            .select({ botId: managedBot.botId })
            .from(managedBot)
            .where(eq(managedBot.userId, userId))
            .get();
        signal.throwIfAborted();
        return row !== undefined;
    };
}
