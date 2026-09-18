import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/database.ts";
import { managedBot } from "../../../schema/index.ts";
import { type BotConfiguration, botConfigurationSchema } from "../entity/bot-configuration.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const managedBotSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof managedBotSchema>;

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
                bindingId: managedBot.bindingId,
                runtimeId: managedBot.runtimeId,
                agentRef: managedBot.agentRef,
                workspaceRef: managedBot.workspaceRef,
                agentConfigRevision: managedBot.agentConfigRevision,
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

    readonly configureBot = async (
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
            .set({ ...value, updatedAt: now })
            .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, v.parse(identifier, botId))))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
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
