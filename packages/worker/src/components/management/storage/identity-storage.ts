import { and, eq, gt, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import * as v from "valibot";
import {
    agentPairingTicket,
    anonymousCredential,
    appUser,
    clerkUserBinding,
    continueLink,
    managedBot,
    platformProjectMapping,
} from "../../../schema/project-do/index.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import {
    type AnonymousIdentity,
    digest,
    IdentityStorageError,
    randomSecret,
    requireIdentityDatabase,
} from "./identity-storage-common.ts";

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

export type BindingResult =
    | { readonly kind: "bound"; readonly userId: string }
    | { readonly kind: "conflict" }
    | { readonly kind: "invalid-local-user" };

export type EndRemoteAccessResult =
    | { readonly kind: "ended-credential"; readonly credentialId: string; readonly userId: string }
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
            database.insert(appUser).values({ id: userId, createdAt: now }),
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
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                ),
            )
            .get();
        signal.throwIfAborted();
        const row = v.safeParse(userRow, result);
        return row.success ? row.output.userId : null;
    };

    readonly createTransfer = async (userId: string, now: number, signal: AbortSignal): Promise<IdentityTransfer> => {
        signal.throwIfAborted();
        const code = createProjectCredential("mobius_transfer_v2", v.parse(v.string(), this.#projectId));
        const expiresAt = now + continueLinkLifetime;
        await requireIdentityDatabase(this.#database)
            .insert(continueLink)
            .values({
                id: `transfer_${crypto.randomUUID()}`,
                codeHash: await digest(code),
                userId,
                expiresAt,
                createdAt: now,
            })
            .run();
        signal.throwIfAborted();
        return { code, expiresAt };
    };

    readonly createRecoveryToken = async (userId: string, now: number, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const token = createProjectCredential("mobius_recovery_v1", v.parse(v.string(), this.#projectId));
        await requireIdentityDatabase(this.#database)
            .insert(anonymousCredential)
            .values({
                id: `cred_${crypto.randomUUID()}`,
                userId,
                tokenHash: await digest(token),
                status: "active",
                createdAt: now,
            })
            .run();
        signal.throwIfAborted();
        return token;
    };

    readonly redeemTransfer = async (
        code: string,
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
        const unexpiredLink = and(
            eq(continueLink.codeHash, codeHash),
            or(
                gt(continueLink.expiresAt, now),
                and(eq(continueLink.expiresAt, 0), gt(sql`${continueLink.createdAt} + ${continueLinkLifetime}`, now)),
            ),
        );
        const results = await database.batch([
            database
                .update(anonymousCredential)
                .set({ status: "active", revokedAt: null })
                .where(
                    and(
                        eq(anonymousCredential.status, "revoked"),
                        inArray(
                            anonymousCredential.remoteTransferId,
                            database
                                .select({ id: continueLink.id })
                                .from(continueLink)
                                .where(and(unexpiredLink, isNotNull(continueLink.revokedAt))),
                        ),
                    ),
                ),
            database
                .update(continueLink)
                .set({
                    claimNonce,
                    revokedAt: null,
                })
                .where(unexpiredLink),
            database.insert(anonymousCredential).select(
                database
                    .select({
                        id: sql<string>`${credentialId}`.as("id"),
                        userId: continueLink.userId,
                        tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                        status: sql<"active">`'active'`.as("status"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
                        remoteTransferId: continueLink.id,
                    })
                    .from(continueLink)
                    .where(and(eq(continueLink.codeHash, codeHash), eq(continueLink.claimNonce, claimNonce))),
            ),
        ]);
        signal.throwIfAborted();
        if (results[1]?.meta.changes !== 1) {
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
                credentialId: anonymousCredential.id,
                userId: anonymousCredential.userId,
            })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                ),
            )
            .get();
        signal.throwIfAborted();
        if (credential === undefined) {
            return { kind: "unauthenticated" };
        }
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
    };

    readonly clerkBinding = async (clerkUserId: string, signal: AbortSignal): Promise<string | null> => {
        signal.throwIfAborted();
        const row = await requireIdentityDatabase(this.#database)
            .select({ userId: clerkUserBinding.userId })
            .from(clerkUserBinding)
            .where(eq(clerkUserBinding.clerkUserId, clerkUserId))
            .get();
        signal.throwIfAborted();
        const parsed = v.safeParse(userRow, row);
        return parsed.success ? parsed.output.userId : null;
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

    readonly resolveOrCreateClerk = async (clerkUserId: string, now: number, signal: AbortSignal): Promise<string> => {
        const existing = await this.clerkBinding(clerkUserId, signal);
        if (existing !== null) {
            return existing;
        }
        const database = requireIdentityDatabase(this.#database);
        await database.batch([
            database.insert(appUser).values({ id: clerkUserId, createdAt: now }).onConflictDoNothing(),
            database
                .insert(clerkUserBinding)
                .values({ clerkUserId, userId: clerkUserId, createdAt: now, updatedAt: now })
                .onConflictDoNothing(),
        ]);
        signal.throwIfAborted();
        const resolved = await this.clerkBinding(clerkUserId, signal);
        if (resolved === null) {
            throw new IdentityStorageError("IDENTITY_UNAVAILABLE", "Identity binding could not be created.");
        }
        return resolved;
    };

    readonly bindClerk = async (
        clerkUserId: string,
        localUserId: string,
        action: "bind" | "discard-local" | "override",
        now: number,
        signal: AbortSignal,
    ): Promise<BindingResult> => {
        const current = await this.clerkBinding(clerkUserId, signal);
        if (current === localUserId) {
            return { kind: "bound", userId: current };
        }
        const database = requireIdentityDatabase(this.#database);
        if (action === "bind") {
            if (current !== null) {
                return { kind: "conflict" };
            }
            const result = await database
                .insert(clerkUserBinding)
                .values({ clerkUserId, userId: localUserId, createdAt: now, updatedAt: now })
                .onConflictDoNothing()
                .run();
            signal.throwIfAborted();
            return result.meta.changes === 1 ? { kind: "bound", userId: localUserId } : { kind: "conflict" };
        }
        if (current === null) {
            return { kind: "conflict" };
        }
        if (action === "override") {
            const result = await database
                .update(clerkUserBinding)
                .set({ userId: localUserId, updatedAt: now })
                .where(
                    and(
                        eq(clerkUserBinding.clerkUserId, clerkUserId),
                        eq(clerkUserBinding.userId, current),
                        notExists(
                            database
                                .select({ userId: clerkUserBinding.userId })
                                .from(clerkUserBinding)
                                .where(eq(clerkUserBinding.userId, localUserId)),
                        ),
                    ),
                )
                .run();
            signal.throwIfAborted();
            return result.meta.changes === 1 ? { kind: "bound", userId: localUserId } : { kind: "invalid-local-user" };
        }
        const localBinding = await database
            .select({ userId: clerkUserBinding.userId })
            .from(clerkUserBinding)
            .where(eq(clerkUserBinding.userId, localUserId))
            .get();
        if (localBinding !== undefined) {
            return { kind: "invalid-local-user" };
        }
        await database.batch([
            database.delete(agentPairingTicket).where(eq(agentPairingTicket.userId, localUserId)),
            database.delete(continueLink).where(eq(continueLink.userId, localUserId)),
            database.delete(anonymousCredential).where(eq(anonymousCredential.userId, localUserId)),
            database.delete(managedBot).where(eq(managedBot.userId, localUserId)),
            database.delete(appUser).where(eq(appUser.id, localUserId)),
        ]);
        signal.throwIfAborted();
        return { kind: "bound", userId: current };
    };
}
