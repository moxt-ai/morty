import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import * as v from "valibot";
import {
    anonymousCredential,
    appUser,
    continueLink,
    platformProjectMapping,
} from "../../../schema/project-do/index.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, randomSecret, requireIdentityDatabase } from "./identity-storage-common.ts";

const anonymousToken = v.pipe(
    v.string(),
    v.regex(
        /^(?:mobius_anon_v2_[A-Za-z0-9_-]{43}|mobius_recovery_v1\.prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43})$/u,
    ),
);
const userRow = v.pipe(v.object({ userId: v.string() }), v.readonly());
const continueLinkLifetime = 24 * 60 * 60 * 1000;
export interface IdentityTransfer {
    readonly code: string;
    readonly expiresAt: number;
}

export type EndRemoteAccessResult =
    | { readonly kind: "ended-credential"; readonly credentialId: string; readonly userId: string }
    | { readonly kind: "ended-transfer"; readonly transferId: string; readonly userId: string }
    | { readonly kind: "unauthenticated" };

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
    ): Promise<AnonymousIdentity> => {
        signal.throwIfAborted();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v2_${randomSecret()}`;
        const database = requireIdentityDatabase(this.#database);
        await database.batch([
            database.insert(appUser).values({ id: userId, createdAt: now }).onConflictDoNothing(),
            database.insert(anonymousCredential).values({
                id: credentialId,
                userId,
                tokenHash: await digest(token),
                status: "active",
                createdAt: now,
            }),
        ]);
        signal.throwIfAborted();
        return { token, userId, projectId };
    };

    readonly authenticateAnonymous = async (token: string, signal: AbortSignal): Promise<string | null> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success || this.#projectId === null) {
            return null;
        }
        signal.throwIfAborted();
        const result = await requireIdentityDatabase(this.#database)
            .select({ userId: anonymousCredential.userId })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(continueLink, eq(continueLink.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                    or(isNull(anonymousCredential.remoteTransferId), isNull(continueLink.revokedAt)),
                ),
            )
            .get();
        signal.throwIfAborted();
        const row = v.safeParse(userRow, result);
        return row.success ? row.output.userId : null;
    };

    readonly isLocalCredential = async (token: string, userId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const row = await requireIdentityDatabase(this.#database)
            .select({ id: anonymousCredential.id })
            .from(anonymousCredential)
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(token)),
                    eq(anonymousCredential.userId, userId),
                    eq(anonymousCredential.status, "active"),
                    isNull(anonymousCredential.remoteTransferId),
                ),
            )
            .get();
        signal.throwIfAborted();
        return row !== undefined;
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
                .set({ status: "revoked", revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.userId, userId),
                        ne(anonymousCredential.tokenHash, tokenHash),
                        eq(anonymousCredential.status, "active"),
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
                            eq(anonymousCredential.status, "active"),
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
                        status: sql<"active">`'active'`.as("status"),
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
                            eq(anonymousCredential.status, "active"),
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
                    or(
                        gt(continueLink.expiresAt, now),
                        and(
                            eq(continueLink.expiresAt, 0),
                            gt(sql`${continueLink.createdAt} + ${continueLinkLifetime}`, now),
                        ),
                    ),
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
                    status: sql<"active">`'active'`.as("status"),
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
                          .set({ status: "revoked", revokedAt: now })
                          .where(and(replaced, eq(anonymousCredential.status, "active"))),
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

    readonly endRemoteAccess = async (
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<EndRemoteAccessResult> => {
        const parsed = v.safeParse(anonymousToken, token);
        if (!parsed.success || this.#projectId === null) {
            return { kind: "unauthenticated" };
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
        const credential = await database
            .select({
                browserId: anonymousCredential.browserId,
                credentialId: anonymousCredential.id,
                transferId: anonymousCredential.remoteTransferId,
                userId: anonymousCredential.userId,
            })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(continueLink, eq(continueLink.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                    or(isNull(anonymousCredential.remoteTransferId), isNull(continueLink.revokedAt)),
                ),
            )
            .get();
        signal.throwIfAborted();
        if (credential === undefined) {
            return { kind: "unauthenticated" };
        }
        if (credential.transferId === null) {
            const revoked = await database
                .update(anonymousCredential)
                .set({ status: "revoked", revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.id, credential.credentialId),
                        eq(anonymousCredential.userId, credential.userId),
                        eq(anonymousCredential.status, "active"),
                    ),
                )
                .run();
            signal.throwIfAborted();
            return revoked.meta.changes === 1
                ? {
                      kind: "ended-credential",
                      credentialId: credential.credentialId,
                      userId: credential.userId,
                  }
                : { kind: "unauthenticated" };
        }
        // The browser joined through this credential's link and through the links of every credential it held.
        const browserId = credential.browserId ?? credential.credentialId;
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
                .set({ status: "revoked", revokedAt: now })
                .where(
                    and(
                        inArray(anonymousCredential.remoteTransferId, transferIds),
                        eq(anonymousCredential.status, "active"),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return { kind: "unauthenticated" };
        }
        return { kind: "ended-transfer", transferId: credential.transferId, userId: credential.userId };
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
