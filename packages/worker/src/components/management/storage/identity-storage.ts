import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import * as v from "valibot";
import { anonymousCredential, continueLink, platformProjectMapping } from "../../../schema/project-do/index.ts";
import type { Credential } from "../entity/authentication/credential.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, randomSecret, requireIdentityDatabase } from "./identity-storage-common.ts";

const userRow = v.pipe(v.object({ userId: v.string() }), v.readonly());
const continueLinkLifetime = 24 * 60 * 60 * 1000;
export interface IdentityTransfer {
    readonly code: string;
    readonly expiresAt: number;
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
                browserId: anonymousCredential.browserId,
            })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(continueLink, eq(continueLink.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(token)),
                    isNull(anonymousCredential.revokedAt),
                    eq(platformProjectMapping.projectId, this.#projectId),
                    or(isNull(anonymousCredential.remoteTransferId), isNull(continueLink.revokedAt)),
                ),
            )
            .get();
        signal.throwIfAborted();
        return result ?? null;
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
                .where(and(eq(continueLink.userId, userId), isNull(continueLink.revokedAt))),
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

    readonly createTransfer = async (
        userId: string,
        parentToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        signal.throwIfAborted();
        const code = createProjectCredential("mobius_transfer_v2", v.parse(v.string(), this.#projectId));
        const expiresAt = now + continueLinkLifetime;
        // Check the issuing credential in the write itself so revocation cannot race issuance.
        const database = requireIdentityDatabase(this.#database);
        const result = await database
            .insert(continueLink)
            .select(
                database
                    .select({
                        id: sql<string>`${`transfer_${crypto.randomUUID()}`}`.as("id"),
                        codeHash: sql<string>`${await digest(code)}`.as("code_hash"),
                        userId: anonymousCredential.userId,
                        expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
                        claimNonce: sql<null>`null`.as("claim_nonce"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
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
        return result.meta.changes === 1 ? { code, expiresAt } : null;
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
                        browserId: sql<null>`null`.as("browser_id"),
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
     * keeps one credential, so the new one replaces it at once and belongs to the same browser. A credential another
     * redemption already replaced still names that browser, so concurrent or retried redemptions stay in it too.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
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
        const claimNonce = crypto.randomUUID();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v2_${randomSecret()}`;
        const claimed = and(eq(continueLink.codeHash, codeHash), eq(continueLink.claimNonce, claimNonce));
        const claim = database
            .update(continueLink)
            .set({ claimNonce })
            .where(
                and(
                    eq(continueLink.codeHash, codeHash),
                    isNull(continueLink.revokedAt),
                    gt(continueLink.expiresAt, now),
                ),
            );
        const replacedHash = replaces === null ? null : await digest(replaces);
        // Only a browser credential of the link's own user names the browser.
        const replaced = and(
            eq(anonymousCredential.tokenHash, replacedHash ?? ""),
            isNotNull(anonymousCredential.remoteTransferId),
            inArray(
                anonymousCredential.userId,
                database.select({ userId: continueLink.userId }).from(continueLink).where(claimed),
            ),
        );
        const browser = database
            .select({ browserId: sql<string>`coalesce(${anonymousCredential.browserId}, ${anonymousCredential.id})` })
            .from(anonymousCredential)
            .where(replaced);
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
                    browserId: (replacedHash === null ? sql<null>`null` : sql<string | null>`(${browser})`).as(
                        "browser_id",
                    ),
                })
                .from(continueLink)
                .where(claimed),
        );
        const results =
            replacedHash === null
                ? await database.batch([claim, issue])
                : await database.batch([
                      claim,
                      issue,
                      database
                          .update(anonymousCredential)
                          .set({ revokedAt: now })
                          .where(and(replaced, isNull(anonymousCredential.revokedAt))),
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

    readonly revokeBrowserAccess = async (
        credential: Extract<Credential, { readonly kind: "browser" }>,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        // The browser joined through this credential's link and through the links of every credential it held.
        const browserId = credential.browserId;
        const held = await database
            .select({ transferId: anonymousCredential.remoteTransferId })
            .from(anonymousCredential)
            .where(
                and(
                    eq(anonymousCredential.userId, credential.userId),
                    or(eq(anonymousCredential.id, browserId), eq(anonymousCredential.browserId, browserId)),
                ),
            )
            .all();
        signal.throwIfAborted();
        const transferIds = [
            ...new Set([
                credential.transferId,
                ...held.flatMap((entry) => (entry.transferId === null ? [] : [entry.transferId])),
            ]),
        ];
        const results = await database.batch([
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(
                    and(
                        eq(continueLink.id, credential.transferId),
                        eq(continueLink.userId, credential.userId),
                        isNull(continueLink.revokedAt),
                    ),
                ),
            database
                .update(continueLink)
                .set({ revokedAt: now })
                .where(
                    and(
                        inArray(continueLink.id, transferIds),
                        eq(continueLink.userId, credential.userId),
                        isNull(continueLink.revokedAt),
                    ),
                ),
            database
                .update(anonymousCredential)
                .set({ revokedAt: now })
                .where(
                    and(
                        inArray(anonymousCredential.remoteTransferId, transferIds),
                        isNull(anonymousCredential.revokedAt),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        return results[0]?.meta.changes === 1;
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
