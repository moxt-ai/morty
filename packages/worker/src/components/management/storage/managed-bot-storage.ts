import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { and, count, eq, exists, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { agentPairingTicket, managedBot } from "../../../schema/project-do/index.ts";
import { type BotConfiguration, botConfigurationSchema } from "../entity/bot-configuration.ts";

const identifier = v.custom<string>(isIdentifier);
const managedBotSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof managedBotSchema>;
export type DeleteManagedBotResult = "deleted" | "last-bot" | "not-found";
export type ConfigureManagedBotResult = "configured" | "not-found" | "runtime-mismatch";

export class ManagedBotStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Database => {
        const database = createDatabase(this.#database);
        if (database === null) {
            throw new ManagementStorageError("DATABASE_UNAVAILABLE", "Management storage is not configured.");
        }
        return database;
    };

    readonly listBots = async (userId: string, signal: AbortSignal): Promise<readonly ManagedBot[]> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: managedBot.botId, displayName: managedBot.displayName })
            .from(managedBot)
            .where(eq(managedBot.userId, userId))
            .orderBy(managedBot.createdAt);
        signal.throwIfAborted();
        return v.parse(v.array(managedBotSchema), result);
    };

    readonly ownsBot = async (userId: string, botId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: managedBot.botId })
            .from(managedBot)
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .get();
        signal.throwIfAborted();
        return result !== undefined || (await this.#readPendingBot(userId, botId, signal)) !== null;
    };

    readonly #readPendingBot = async (userId: string, botId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
            .select({ botId: agentPairingTicket.botId })
            .from(agentPairingTicket)
            .where(
                and(
                    eq(agentPairingTicket.userId, userId),
                    eq(agentPairingTicket.botId, v.parse(identifier, botId)),
                    eq(agentPairingTicket.createsBot, true),
                    isNotNull(agentPairingTicket.consumedAt),
                ),
            )
            .get();
        signal.throwIfAborted();
        return row === undefined
            ? null
            : { botId: row.botId, displayName: "My Machine", configuration: null, instructions: "" };
    };

    readonly readBot = async (
        userId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<
        | (ManagedBot & {
              readonly configuration: BotConfiguration | null;
              readonly instructions: string;
          })
        | null
    > => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
            .select({
                botId: managedBot.botId,
                displayName: managedBot.displayName,
                runtimeId: managedBot.runtimeId,
                instructions: managedBot.instructions,
            })
            .from(managedBot)
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .get();
        signal.throwIfAborted();
        if (row === undefined) {
            return await this.#readPendingBot(userId, botId, signal);
        }
        const bot = v.parse(managedBotSchema, row);
        const configuration = v.safeParse(botConfigurationSchema, row);
        return {
            ...bot,
            configuration: configuration.success ? configuration.output : null,
            instructions: row.instructions,
        };
    };

    readonly configureBot = async (
        userId: string,
        botId: string,
        configuration: BotConfiguration,
        now: number,
        signal: AbortSignal,
    ): Promise<ConfigureManagedBotResult> => {
        const value = v.parse(botConfigurationSchema, configuration);
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const pending = and(
            eq(agentPairingTicket.userId, userId),
            eq(agentPairingTicket.botId, v.parse(identifier, botId)),
            eq(agentPairingTicket.createsBot, true),
            isNotNull(agentPairingTicket.consumedAt),
        );
        const results = await database.batch([
            database
                .insert(managedBot)
                .select(
                    database
                        .select({
                            userId: agentPairingTicket.userId,
                            botId: agentPairingTicket.botId,
                            displayName:
                                sql<string>`'My Machine ' || (${database.select({ count: count() }).from(managedBot).where(eq(managedBot.userId, agentPairingTicket.userId))} + 1)`.as(
                                    "display_name",
                                ),
                            runtimeId: sql<string>`${value.runtimeId}`.as("runtime_id"),
                            instructions: sql<string>`''`.as("instructions"),
                            createdAt: sql<number>`${now}`.as("created_at"),
                            updatedAt: sql<number>`${now}`.as("updated_at"),
                        })
                        .from(agentPairingTicket)
                        .where(pending),
                )
                .onConflictDoNothing(),
            database
                .update(managedBot)
                .set({ runtimeId: value.runtimeId, updatedAt: now })
                .where(
                    and(
                        eq(managedBot.userId, userId),
                        eq(managedBot.botId, v.parse(identifier, botId)),
                        or(isNull(managedBot.runtimeId), eq(managedBot.runtimeId, value.runtimeId)),
                    ),
                ),
            database
                .update(agentPairingTicket)
                .set({ createsBot: false })
                .where(
                    and(
                        pending,
                        exists(
                            database
                                .select({ botId: managedBot.botId })
                                .from(managedBot)
                                .where(
                                    and(
                                        eq(managedBot.botId, agentPairingTicket.botId),
                                        eq(managedBot.userId, userId),
                                        eq(managedBot.runtimeId, value.runtimeId),
                                    ),
                                ),
                        ),
                    ),
                ),
        ]);
        signal.throwIfAborted();
        if (results[1]?.meta.changes === 1) {
            return "configured";
        }
        const current = await database
            .select({ runtimeId: managedBot.runtimeId })
            .from(managedBot)
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .get();
        signal.throwIfAborted();
        if (current === undefined) {
            return "not-found";
        }
        return current.runtimeId !== null && current.runtimeId !== value.runtimeId ? "runtime-mismatch" : "not-found";
    };

    readonly updateBot = async (
        userId: string,
        botId: string,
        input: { readonly displayName: string; readonly instructions: string },
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .update(managedBot)
            .set({
                displayName: v.parse(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)), input.displayName),
                instructions: v.parse(v.pipe(v.string(), v.maxLength(100000)), input.instructions),
                updatedAt: now,
            })
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly deleteBot = async (
        userId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<DeleteManagedBotResult> => {
        const parsedBotId = v.parse(identifier, botId);
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const result = await database
            .delete(managedBot)
            .where(
                and(
                    eq(managedBot.userId, userId),
                    eq(managedBot.botId, parsedBotId),
                    gt(database.$count(managedBot, eq(managedBot.userId, userId)), 1),
                ),
            )
            .run();
        signal.throwIfAborted();
        if (result.meta.changes === 1) {
            return "deleted";
        }
        return (await this.ownsBot(userId, parsedBotId, signal)) ? "last-bot" : "not-found";
    };

    readonly saveClaim = async (userId: string, bot: ManagedBot, now: number, signal: AbortSignal): Promise<void> => {
        const value = v.parse(managedBotSchema, bot);
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(managedBot)
            .values({
                userId,
                botId: value.botId,
                displayName: value.displayName,
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: managedBot.botId,
                set: { displayName: value.displayName, updatedAt: now },
                setWhere: eq(managedBot.userId, userId),
            })
            .run();
        signal.throwIfAborted();
        if (!(await this.ownsBot(userId, value.botId, signal))) {
            throw new ManagementStorageError("BOT_ALREADY_CLAIMED", "This bot is already owned by another user.");
        }
    };
}

class ManagementStorageError extends Error implements HttpError {
    readonly code: "BOT_ALREADY_CLAIMED" | "DATABASE_UNAVAILABLE";
    constructor(code: "BOT_ALREADY_CLAIMED" | "DATABASE_UNAVAILABLE", message: string) {
        super(message);
        this.code = code;
        this.name = "ManagementStorageError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.code === "BOT_ALREADY_CLAIMED" ? 409 : 503,
    });
}
