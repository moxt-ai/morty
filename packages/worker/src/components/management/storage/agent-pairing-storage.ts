import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import * as v from "valibot";
import { agentPairingTicket, anonymousCredential, managedBot } from "../../../schema/project-do/index.ts";
import { createProjectCredential, readProjectCredential } from "../entity/project-credential.ts";
import { type AnonymousIdentity, digest, randomSecret, requireIdentityDatabase } from "./identity-storage-common.ts";

const agentPairingLifetime = 10 * 60 * 1000;

export interface AgentPairing {
    readonly code: string;
    readonly expiresAt: number;
}

export class AgentPairingStorage {
    readonly #database: unknown;
    readonly #projectId: string | null;

    constructor(database: unknown, projectId: string | null = null) {
        this.#database = database;
        this.#projectId = projectId;
    }

    readonly createPairing = async (
        userId: string,
        botId: string,
        expectedRuntimeId: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<AgentPairing> => {
        signal.throwIfAborted();
        const code = createProjectCredential("mobius_pair_v2", v.parse(v.string(), this.#projectId));
        const expiresAt = now + agentPairingLifetime;
        await requireIdentityDatabase(this.#database)
            .insert(agentPairingTicket)
            .values({ codeHash: await digest(code), userId, botId, expectedRuntimeId, expiresAt })
            .run();
        signal.throwIfAborted();
        return { code, expiresAt };
    };

    readonly redeemPairing = async (
        code: string,
        now: number,
        signal: AbortSignal,
    ): Promise<
        | (AnonymousIdentity & {
              readonly botId: string;
              readonly expectedRuntimeId: string | null;
          })
        | null
    > => {
        const parsed = readProjectCredential(code);
        if (parsed?.kind !== "mobius_pair_v2" || parsed.projectId !== this.#projectId) {
            return null;
        }
        signal.throwIfAborted();
        const database = requireIdentityDatabase(this.#database);
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
            v.object({ userId: v.string(), botId: v.string(), expectedRuntimeId: v.nullable(v.string()) }),
            await database
                .select({
                    userId: agentPairingTicket.userId,
                    botId: agentPairingTicket.botId,
                    expectedRuntimeId: agentPairingTicket.expectedRuntimeId,
                })
                .from(agentPairingTicket)
                .where(and(eq(agentPairingTicket.codeHash, hash), eq(agentPairingTicket.claimNonce, nonce)))
                .get(),
        );
        signal.throwIfAborted();
        return { ...row, token, projectId: parsed.projectId };
    };
}
