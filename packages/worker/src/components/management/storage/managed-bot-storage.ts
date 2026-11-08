import { isIdentifier } from "@morty-build/client/protocol";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { managedBot } from "../../../schema/project-do/index.ts";
import { type BotConfiguration, botConfigurationSchema } from "../entity/bot-configuration.ts";

const identifier = v.custom<string>(isIdentifier);
const managedBotSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);

const listedBotSchema = v.pipe(
    v.object({
        botId: identifier,
        displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        runtimeId: v.nullable(identifier),
    }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof managedBotSchema>;
type ListedManagedBot = v.InferOutput<typeof listedBotSchema>;

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

    /** The user's Machines, oldest first. */
    readonly listBots = async (userId: string, signal: AbortSignal): Promise<readonly ListedManagedBot[]> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: managedBot.botId, displayName: managedBot.displayName, runtimeId: managedBot.runtimeId })
            .from(managedBot)
            .where(eq(managedBot.userId, userId))
            .orderBy(managedBot.createdAt, managedBot.botId);
        signal.throwIfAborted();
        return v.parse(v.array(listedBotSchema), result);
    };

    readonly ownsBot = async (userId: string, botId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: managedBot.botId })
            .from(managedBot)
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .get();
        signal.throwIfAborted();
        return result !== undefined;
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
            return null;
        }
        const bot = v.parse(managedBotSchema, row);
        const configuration = v.safeParse(botConfigurationSchema, row);
        return {
            ...bot,
            configuration: configuration.success ? configuration.output : null,
            instructions: row.instructions,
        };
    };

    /**
     * Records the Machine's first Runtime binding. The write applies only while the Machine has none, so of two
     * concurrent bindings exactly one is recorded; whether a binding is allowed is the management service's decision.
     */
    readonly bindUnbound = async (
        userId: string,
        botId: string,
        configuration: BotConfiguration,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const value = v.parse(botConfigurationSchema, configuration);
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .update(managedBot)
            .set({ runtimeId: value.runtimeId, updatedAt: now })
            .where(
                and(
                    eq(managedBot.userId, userId),
                    eq(managedBot.botId, v.parse(identifier, botId)),
                    isNull(managedBot.runtimeId),
                ),
            )
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
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
