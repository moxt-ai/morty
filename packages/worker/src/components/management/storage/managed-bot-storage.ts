import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const titleSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const managedBotSchema = v.pipe(
    v.object({ botId: identifier, displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)) }),
    v.readonly(),
);
const chatSessionSchema = v.pipe(
    v.object({
        botId: identifier,
        sessionId: identifier,
        title: titleSchema,
    }),
    v.readonly(),
);

export type ManagedBot = v.InferOutput<typeof managedBotSchema>;
export type ChatSessionRecord = v.InferOutput<typeof chatSessionSchema>;

function isDatabase(value: unknown): value is Pick<D1Database, "prepare"> {
    return typeof value === "object" && value !== null && "prepare" in value && typeof value.prepare === "function";
}

export class ManagedBotStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Pick<D1Database, "prepare"> => {
        const database = this.#database;
        if (!isDatabase(database)) {
            throw new ManagementStorageError("DATABASE_UNAVAILABLE", "Management storage is not configured.");
        }
        return database;
    };

    readonly listBots = async (userId: string, signal: AbortSignal): Promise<readonly ManagedBot[]> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare(
                "SELECT bot_id AS botId, display_name AS displayName FROM managed_bot WHERE user_id = ? ORDER BY created_at",
            )
            .bind(userId)
            .all();
        signal.throwIfAborted();
        return v.parse(v.array(managedBotSchema), result.results);
    };

    readonly ownsBot = async (userId: string, botId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("SELECT 1 AS owned FROM managed_bot WHERE user_id = ? AND bot_id = ?")
            .bind(userId, v.parse(identifier, botId))
            .first();
        signal.throwIfAborted();
        return result !== null;
    };

    readonly saveClaim = async (userId: string, bot: ManagedBot, now: number, signal: AbortSignal): Promise<void> => {
        const value = v.parse(managedBotSchema, bot);
        signal.throwIfAborted();
        await this.#requireDatabase()
            .prepare(
                "INSERT INTO managed_bot (user_id, bot_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bot_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at WHERE managed_bot.user_id = excluded.user_id",
            )
            .bind(userId, value.botId, value.displayName, now, now)
            .run();
        signal.throwIfAborted();
        if (!(await this.ownsBot(userId, value.botId, signal))) {
            throw new ManagementStorageError("BOT_ALREADY_CLAIMED", "This bot is already owned by another user.");
        }
    };

    readonly saveAccessToken = async (
        userId: string,
        botId: string,
        accessTokenId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("INSERT INTO chat_access_token (access_token_id, user_id, bot_id, created_at) VALUES (?, ?, ?, ?)")
            .bind(v.parse(identifier, accessTokenId), userId, v.parse(identifier, botId), now)
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly ownsAccessToken = async (userId: string, accessTokenId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("SELECT 1 AS owned FROM chat_access_token WHERE user_id = ? AND access_token_id = ?")
            .bind(userId, v.parse(identifier, accessTokenId))
            .first();
        signal.throwIfAborted();
        return result !== null;
    };

    readonly accessTokenBot = async (
        userId: string,
        accessTokenId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("SELECT bot_id AS botId FROM chat_access_token WHERE user_id = ? AND access_token_id = ?")
            .bind(userId, v.parse(identifier, accessTokenId))
            .first();
        signal.throwIfAborted();
        const parsed = v.safeParse(v.object({ botId: identifier }), result);
        return parsed.success ? parsed.output.botId : null;
    };

    readonly deleteAccessToken = async (
        userId: string,
        accessTokenId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("DELETE FROM chat_access_token WHERE user_id = ? AND access_token_id = ?")
            .bind(userId, v.parse(identifier, accessTokenId))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly listSessions = async (userId: string, signal: AbortSignal): Promise<readonly ChatSessionRecord[]> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare(
                "SELECT bot_id AS botId, session_id AS sessionId, title FROM chat_session WHERE user_id = ? ORDER BY updated_at DESC",
            )
            .bind(userId)
            .all();
        signal.throwIfAborted();
        return v.parse(v.array(chatSessionSchema), result.results);
    };

    readonly saveSession = async (
        userId: string,
        session: ChatSessionRecord,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const value = v.parse(chatSessionSchema, session);
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare(
                "INSERT INTO chat_session (user_id, session_id, bot_id, title, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM managed_bot WHERE user_id = ? AND bot_id = ?)",
            )
            .bind(userId, value.sessionId, value.botId, value.title, now, now, userId, value.botId)
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly renameSession = async (
        userId: string,
        sessionId: string,
        title: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("UPDATE chat_session SET title = ?, updated_at = ? WHERE user_id = ? AND session_id = ?")
            .bind(v.parse(titleSchema, title), now, userId, v.parse(identifier, sessionId))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly deleteSession = async (userId: string, sessionId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .prepare("DELETE FROM chat_session WHERE user_id = ? AND session_id = ?")
            .bind(userId, v.parse(identifier, sessionId))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
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
