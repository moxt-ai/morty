import { and, eq, exists, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/database.ts";
import {
    agentPairingTicket,
    anonymousCredential,
    appUser,
    clerkUserBinding,
    identityTransfer,
    managedBot,
    platformProjectMapping,
} from "../../../schema/index.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";

const anonymousToken = v.pipe(v.string(), v.regex(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u));
const userRow = v.pipe(v.object({ userId: v.string() }), v.readonly());
const oneTimeCredentialLifetime = 24 * 60 * 60 * 1000;

function randomSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AnonymousIdentity {
    readonly token: string;
    readonly userId: string;
    readonly projectId: string;
}

export interface IdentityTransfer {
    readonly code: string;
    readonly expiresAt: number;
}

export type BindingResult =
    | { readonly kind: "bound"; readonly userId: string }
    | { readonly kind: "conflict" }
    | { readonly kind: "invalid-local-user" };

export type EndRemoteAccessResult =
    | { readonly kind: "ended"; readonly transferId: string; readonly userId: string }
    | { readonly kind: "not-remote" }
    | { readonly kind: "unauthenticated" };

export class IdentityStorage {
    readonly #database: unknown;
    readonly #projectId: string | null;

    constructor(database: unknown, projectId: string | null = null) {
        this.#database = database;
        this.#projectId = projectId;
    }

    readonly #requireDatabase = (): Database => {
        const database = createDatabase(this.#database);
        if (database === null) {
            throw new IdentityStorageError("IDENTITY_UNAVAILABLE", "Identity storage is unavailable.");
        }
        return database;
    };

    readonly createAnonymous = async (
        userId: string,
        projectId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity> => {
        signal.throwIfAborted();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v2_${randomSecret()}`;
        const database = this.#requireDatabase();
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
        const result = await this.#requireDatabase()
            .select({ userId: anonymousCredential.userId })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(identityTransfer, eq(identityTransfer.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                    or(
                        isNull(anonymousCredential.remoteTransferId),
                        and(isNull(identityTransfer.revokedAt), gt(identityTransfer.expiresAt, Date.now())),
                    ),
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
        const expiresAt = now + oneTimeCredentialLifetime;
        await this.#requireDatabase()
            .insert(identityTransfer)
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
        const database = this.#requireDatabase();
        const codeHash = await digest(code);
        const claimNonce = crypto.randomUUID();
        const credentialId = `cred_${crypto.randomUUID()}`;
        const token = `mobius_anon_v2_${randomSecret()}`;
        const results = await database.batch([
            database
                .update(identityTransfer)
                .set({
                    redemptionCount: sql`${identityTransfer.redemptionCount} + 1`,
                    consumedAt: sql`case when ${identityTransfer.redemptionCount} + 1 = 5 then ${now} else null end`,
                    claimNonce,
                })
                .where(
                    and(
                        eq(identityTransfer.codeHash, codeHash),
                        isNull(identityTransfer.consumedAt),
                        lt(identityTransfer.redemptionCount, 5),
                        gt(identityTransfer.expiresAt, now),
                    ),
                ),
            database.insert(anonymousCredential).select(
                database
                    .select({
                        id: sql<string>`${credentialId}`.as("id"),
                        userId: identityTransfer.userId,
                        tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                        status: sql<"active">`'active'`.as("status"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
                        remoteTransferId: identityTransfer.id,
                    })
                    .from(identityTransfer)
                    .where(and(eq(identityTransfer.codeHash, codeHash), eq(identityTransfer.claimNonce, claimNonce))),
            ),
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
        const database = this.#requireDatabase();
        const credential = await database
            .select({
                transferId: anonymousCredential.remoteTransferId,
                userId: anonymousCredential.userId,
            })
            .from(anonymousCredential)
            .innerJoin(platformProjectMapping, eq(platformProjectMapping.userId, anonymousCredential.userId))
            .leftJoin(identityTransfer, eq(identityTransfer.id, anonymousCredential.remoteTransferId))
            .where(
                and(
                    eq(anonymousCredential.tokenHash, await digest(parsed.output)),
                    eq(anonymousCredential.status, "active"),
                    eq(platformProjectMapping.projectId, this.#projectId),
                    or(
                        isNull(anonymousCredential.remoteTransferId),
                        and(isNull(identityTransfer.revokedAt), gt(identityTransfer.expiresAt, now)),
                    ),
                ),
            )
            .get();
        signal.throwIfAborted();
        if (credential === undefined) {
            return { kind: "unauthenticated" };
        }
        if (credential.transferId === null) {
            return { kind: "not-remote" };
        }
        const results = await database.batch([
            database
                .update(identityTransfer)
                .set({ revokedAt: now, consumedAt: now })
                .where(
                    and(
                        eq(identityTransfer.id, credential.transferId),
                        eq(identityTransfer.userId, credential.userId),
                        isNull(identityTransfer.revokedAt),
                    ),
                ),
            database
                .update(anonymousCredential)
                .set({ status: "revoked", revokedAt: now })
                .where(
                    and(
                        eq(anonymousCredential.remoteTransferId, credential.transferId),
                        eq(anonymousCredential.status, "active"),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return { kind: "unauthenticated" };
        }
        return { kind: "ended", transferId: credential.transferId, userId: credential.userId };
    };

    readonly clerkBinding = async (clerkUserId: string, signal: AbortSignal): Promise<string | null> => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
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
        const row = await this.#requireDatabase()
            .select({ projectId: platformProjectMapping.projectId })
            .from(platformProjectMapping)
            .where(and(eq(platformProjectMapping.userId, userId), eq(platformProjectMapping.projectId, projectId)))
            .get();
        signal.throwIfAborted();
        return row !== undefined;
    };

    readonly createPairing = async (
        userId: string,
        botId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<IdentityTransfer> => {
        signal.throwIfAborted();
        const code = createProjectCredential("mobius_pair_v2", v.parse(v.string(), this.#projectId));
        const expiresAt = now + oneTimeCredentialLifetime;
        await this.#requireDatabase()
            .insert(agentPairingTicket)
            .values({ codeHash: await digest(code), userId, botId, expiresAt })
            .run();
        signal.throwIfAborted();
        return { code, expiresAt };
    };

    readonly redeemPairing = async (
        code: string,
        now: number,
        signal: AbortSignal,
    ): Promise<(AnonymousIdentity & { readonly botId: string }) | null> => {
        const parsed = readProjectCredential(code);
        if (parsed?.kind !== "mobius_pair_v2" || parsed.projectId !== this.#projectId) {
            return null;
        }
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const hash = await digest(code);
        const nonce = crypto.randomUUID();
        const token = `mobius_anon_v2_${randomSecret()}`;
        const credentialId = `cred_${crypto.randomUUID()}`;
        const results = await database.batch([
            database
                .update(agentPairingTicket)
                .set({ consumedAt: now, claimNonce: nonce })
                .where(
                    and(
                        eq(agentPairingTicket.codeHash, hash),
                        isNull(agentPairingTicket.consumedAt),
                        gt(agentPairingTicket.expiresAt, now),
                        exists(
                            database
                                .select({ botId: managedBot.botId })
                                .from(managedBot)
                                .where(
                                    and(
                                        eq(managedBot.botId, agentPairingTicket.botId),
                                        eq(managedBot.userId, agentPairingTicket.userId),
                                    ),
                                ),
                        ),
                    ),
                ),
            database.insert(anonymousCredential).select(
                database
                    .select({
                        id: sql<string>`${credentialId}`.as("id"),
                        userId: agentPairingTicket.userId,
                        tokenHash: sql<string>`${await digest(token)}`.as("token_hash"),
                        status: sql<"active">`'active'`.as("status"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        revokedAt: sql<null>`null`.as("revoked_at"),
                        remoteTransferId: sql<null>`null`.as("remote_transfer_id"),
                    })
                    .from(agentPairingTicket)
                    .where(and(eq(agentPairingTicket.codeHash, hash), eq(agentPairingTicket.claimNonce, nonce))),
            ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            return null;
        }
        const row = v.parse(
            v.object({ userId: v.string(), botId: v.string() }),
            await database
                .select({ userId: agentPairingTicket.userId, botId: agentPairingTicket.botId })
                .from(agentPairingTicket)
                .where(and(eq(agentPairingTicket.codeHash, hash), eq(agentPairingTicket.claimNonce, nonce)))
                .get(),
        );
        signal.throwIfAborted();
        return { ...row, token, projectId: parsed.projectId };
    };

    readonly resolveOrCreateClerk = async (clerkUserId: string, now: number, signal: AbortSignal): Promise<string> => {
        const existing = await this.clerkBinding(clerkUserId, signal);
        if (existing !== null) {
            return existing;
        }
        const database = this.#requireDatabase();
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
        const database = this.#requireDatabase();
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
            database.delete(identityTransfer).where(eq(identityTransfer.userId, localUserId)),
            database.delete(anonymousCredential).where(eq(anonymousCredential.userId, localUserId)),
            database.delete(managedBot).where(eq(managedBot.userId, localUserId)),
            database.delete(appUser).where(eq(appUser.id, localUserId)),
        ]);
        signal.throwIfAborted();
        return { kind: "bound", userId: current };
    };
}

class IdentityStorageError extends Error implements HttpError {
    readonly code: "IDENTITY_UNAVAILABLE";
    constructor(code: "IDENTITY_UNAVAILABLE", message: string) {
        super(message);
        this.code = code;
        this.name = "IdentityStorageError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: 503,
    });
}
