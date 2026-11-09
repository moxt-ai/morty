import { isIdentifier } from "@morty-build/client/protocol";
import { and, eq, isNull, or } from "drizzle-orm";
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

    /** The Machine of this Project's owner, if it has one. */
    readonly readMachine = async (userId: string, signal: AbortSignal): Promise<ListedManagedBot | null> => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
            .select({ botId: managedBot.botId, displayName: managedBot.displayName, runtimeId: managedBot.runtimeId })
            .from(managedBot)
            .where(eq(managedBot.userId, userId))
            .get();
        signal.throwIfAborted();
        return row === undefined ? null : v.parse(listedBotSchema, row);
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

    /** Binds the Machine to a Runtime: one it has none of, or in place of `replaced`, a Runtime that was revoked. */
    readonly configureBot = async (
        userId: string,
        botId: string,
        configuration: BotConfiguration,
        replaced: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<ConfigureManagedBotResult> => {
        const value = v.parse(botConfigurationSchema, configuration);
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const result = await database
            .update(managedBot)
            .set({ runtimeId: value.runtimeId, updatedAt: now })
            .where(
                and(
                    eq(managedBot.userId, userId),
                    eq(managedBot.botId, v.parse(identifier, botId)),
                    or(
                        replaced === null ? isNull(managedBot.runtimeId) : eq(managedBot.runtimeId, replaced),
                        eq(managedBot.runtimeId, value.runtimeId),
                    ),
                ),
            )
            .run();
        signal.throwIfAborted();
        if (result.meta.changes === 1) {
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

    /**
     * Gives the owner `machine` unless it already has a Machine, and returns the owner's Machine either way: the owner
     * is the key, so a repeated or concurrent claim never adds a second one.
     */
    readonly claimMachine = async (
        userId: string,
        machine: ManagedBot,
        now: number,
        signal: AbortSignal,
    ): Promise<ListedManagedBot> => {
        const value = v.parse(managedBotSchema, machine);
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(managedBot)
            .values({ userId, botId: value.botId, displayName: value.displayName, createdAt: now, updatedAt: now })
            .onConflictDoNothing({ target: managedBot.userId })
            .run();
        const claimed = await this.readMachine(userId, signal);
        if (claimed === null) {
            throw new ManagementStorageError("DATABASE_UNAVAILABLE", "The Machine could not be stored.");
        }
        return claimed;
    };
}

class ManagementStorageError extends Error implements HttpError {
    readonly code: "DATABASE_UNAVAILABLE";
    constructor(code: "DATABASE_UNAVAILABLE", message: string) {
        super(message);
        this.code = code;
        this.name = "ManagementStorageError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: 503,
    });
}
