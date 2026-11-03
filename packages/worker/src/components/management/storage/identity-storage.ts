import { and, eq, exists, gt, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as v from "valibot";
import {
    anonymousCredential,
    browserDevice,
    continueLink,
    platformProjectMapping,
} from "../../../schema/project-do/index.ts";
import type { Credential, SharedLinkTerms } from "../entity/authentication/credential.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, randomSecret, requireIdentityDatabase } from "./identity-storage-common.ts";

const userRow = v.pipe(v.object({ userId: v.string() }), v.readonly());

/** A link no device has used yet: it issued no credential. */
function unusedLink(database: ReturnType<typeof requireIdentityDatabase>) {
    return notExists(
        database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(eq(anonymousCredential.remoteTransferId, continueLink.id)),
    );
}
export interface IdentityTransfer extends SharedLinkTerms {
    readonly code: string;
}

export class IdentityStorage {
    readonly #database: unknown;
    readonly #projectId: string | null;

    constructor(database: unknown, projectId: string | null = null) {
        this.#database = database;
        this.#projectId = projectId;
    }

    readonly createAnonymous = async (
        userId: string,
        projectId: string,
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
        return credential === undefined ? null : { token, userId, projectId };
    };

    readonly findCredential = async (token: string, signal: AbortSignal) => {
        if (this.#projectId === null) {
            return null;
        }
        signal.throwIfAborted();
        const result = await requireIdentityDatabase(this.#database)
            .select({
                credentialId: anonymousCredential.id,
                userId: anonymousCredential.userId,
                kind: anonymousCredential.kind,
                transferId: anonymousCredential.remoteTransferId,
                deviceId: anonymousCredential.deviceId,
                revokedAt: anonymousCredential.revokedAt,
                // Durable Object rows are keyed by column name, so this column needs a name of its own.
                accessExpiresAt: sql<number | null>`${continueLink.accessExpiresAt}`.as("link_access_expires_at"),
            })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(continueLink, eq(continueLink.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(token)),
                    eq(platformProjectMapping.projectId, this.#projectId),
                ),
            )
            .get();
        signal.throwIfAborted();
        return result ?? null;
    };

    /**
     * The user's browser devices with each credential that is not revoked, so the caller can apply the access rule: a
     * device described by its first joining, the term of each credential's link, and who shared the link it joined
     * through.
     */
    readonly linkedDevices = async (userId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const currentLink = alias(continueLink, "current_link");
        const joinedThrough = alias(continueLink, "joined_through_link");
        const sharer = alias(anonymousCredential, "sharer_credential");
        const sharerDevice = alias(browserDevice, "sharer_device");
        const rows = await requireIdentityDatabase(this.#database)
            .select({
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserDevice.id}`.as("device_id"),
                joinedAt: browserDevice.joinedAt,
                label: browserDevice.label,
                revokedAt: anonymousCredential.revokedAt,
                accessExpiresAt: sql<number>`${currentLink.accessExpiresAt}`.as("access_expires_at"),
                sharerKind: sql<Credential["kind"] | null>`${sharer.kind}`.as("sharer_kind"),
                sharerLabel: sql<string | null>`${sharerDevice.label}`.as("sharer_label"),
            })
            .from(browserDevice)
            .innerJoin(anonymousCredential, eq(anonymousCredential.deviceId, browserDevice.id))
            .innerJoin(currentLink, eq(currentLink.id, anonymousCredential.remoteTransferId))
            .leftJoin(joinedThrough, eq(joinedThrough.id, browserDevice.joinedThroughTransferId))
            .leftJoin(sharer, eq(sharer.id, joinedThrough.createdByCredentialId))
            .leftJoin(sharerDevice, eq(sharerDevice.id, sharer.deviceId))
            // A revoked credential never holds access again; reading only the others keeps the list short.
            .where(and(eq(browserDevice.userId, userId), isNull(anonymousCredential.revokedAt)))
            .all();
        signal.throwIfAborted();
        return rows;
    };

    readonly identifyLegacyCredential = async (
        credentialId: string,
        kind: Credential["kind"],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await requireIdentityDatabase(this.#database)
            .update(anonymousCredential)
            .set({ kind })
            .where(and(eq(anonymousCredential.id, credentialId), isNull(anonymousCredential.kind)))
            .run();
        signal.throwIfAborted();
    };

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
                        ne(anonymousCredential.tokenHash, tokenHash),
                        isNull(anonymousCredential.revokedAt),
                    ),
                ),
        ]);
        signal.throwIfAborted();
    };

    /**
     * Ends the access of every browser device except the one kept, and voids the links no device has used yet. The
     * machine's own and recovery credentials belong to no device, so they stay, including unclassified legacy ones.
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
            database
                .update(anonymousCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.userId, userId),
                        isNotNull(anonymousCredential.deviceId),
                        keptDeviceId === null ? undefined : ne(anonymousCredential.deviceId, keptDeviceId),
                        isNull(anonymousCredential.revokedAt),
                    ),
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
        const code = createProjectCredential("mobius_transfer_v2", v.parse(v.string(), this.#projectId));
        // Check the issuing credential in the write itself so revocation cannot race issuance. Its term needs no check
        // here: the terms are capped by it, so a link shared after it ended adds no device.
        const database = requireIdentityDatabase(this.#database);
        const parentTokenHash = await digest(parentToken);
        const issuer = and(
            eq(anonymousCredential.userId, userId),
            eq(anonymousCredential.tokenHash, parentTokenHash),
            isNull(anonymousCredential.revokedAt),
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
        const token = createProjectCredential("mobius_recovery_v1", v.parse(v.string(), this.#projectId));
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

    /**
     * Opens a link in a browser. `replaces` is the credential the browser already holds for this Project: a browser
     * keeps one credential, so the new one replaces it at once and belongs to the same device. A browser holding none
     * becomes a new device, described by this joining.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        deviceLabel: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => {
        const parsed = readProjectCredential(code);
        if (parsed?.kind !== "mobius_transfer_v2" || parsed.projectId !== this.#projectId) {
            return null;
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const codeHash = await digest(code);
        const credentialId = `cred_${crypto.randomUUID()}`;
        const newDeviceId = `device_${crypto.randomUUID()}`;
        const token = `mobius_anon_v2_${randomSecret()}`;
        // A link adds one device: only while no credential was issued through it.
        const open = and(
            eq(continueLink.codeHash, codeHash),
            isNull(continueLink.revokedAt),
            gt(continueLink.expiresAt, now),
            gt(continueLink.accessExpiresAt, now),
            unusedLink(database),
        );
        const replacedHash = replaces === null ? null : await digest(replaces);
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
        const replacedDevice = database
            .select({ deviceId: anonymousCredential.deviceId })
            .from(anonymousCredential)
            .where(replaced);
        const issued = database
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(eq(anonymousCredential.id, credentialId));
        const issue = database.insert(anonymousCredential).select(
            database
                .select({
                    id: sql<string>`${credentialId}`.as("id"),
                    userId: continueLink.userId,
                    tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                    kind: sql<"browser">`'browser'`.as("kind"),
                    createdAt: sql<number>`${now}`.as("created_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    remoteTransferId: continueLink.id,
                    deviceId: (replacedHash === null
                        ? sql<string>`${newDeviceId}`
                        : sql<string>`coalesce((${replacedDevice}), ${newDeviceId})`
                    ).as("device_id"),
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
                    label: sql<string | null>`${deviceLabel}`.as("label"),
                    joinedThroughTransferId: anonymousCredential.remoteTransferId,
                })
                .from(anonymousCredential)
                .where(and(eq(anonymousCredential.id, credentialId), eq(anonymousCredential.deviceId, newDeviceId))),
        );
        const results = await database.batch([
            issue,
            describe,
            database
                .update(anonymousCredential)
                .set({ revokedAt: now })
                .where(and(replaced, isNull(anonymousCredential.revokedAt), exists(issued))),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return null;
        }
        const row = await database
            .select({ userId: anonymousCredential.userId })
            .from(anonymousCredential)
            .where(eq(anonymousCredential.id, credentialId))
            .get();
        const user = v.parse(userRow, row);
        return { token, userId: user.userId, projectId: parsed.projectId };
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

    /** Ends a browser device's access: every credential it holds, so a retried or concurrent redemption ends too. */
    readonly revokeBrowserAccess = async (
        credential: Extract<Credential, { readonly kind: "browser" }>,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const revoked = await requireIdentityDatabase(this.#database)
            .update(anonymousCredential)
            .set({ revokedAt: now })
            .where(
                and(
                    eq(anonymousCredential.userId, credential.userId),
                    eq(anonymousCredential.deviceId, credential.deviceId),
                    isNull(anonymousCredential.revokedAt),
                ),
            )
            .run();
        signal.throwIfAborted();
        return revoked.meta.changes > 0;
    };

    readonly ownsProject = async (userId: string, projectId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const row = await requireIdentityDatabase(this.#database)
            .select({ projectId: platformProjectMapping.projectId })
            .from(platformProjectMapping)
            .where(and(eq(platformProjectMapping.userId, userId), eq(platformProjectMapping.projectId, projectId)))
            .get();
        signal.throwIfAborted();
        return row !== undefined;
    };
}
