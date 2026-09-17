import { and, desc, eq, exists, sql } from "drizzle-orm";
import * as v from "valibot";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/database.ts";
import { chatAccessToken, chatSession, managedBot } from "../../../schema/index.ts";

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

    readonly saveClaim = async (userId: string, bot: ManagedBot, now: number, signal: AbortSignal): Promise<void> => {
        const value = v.parse(managedBotSchema, bot);
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(managedBot)
            .values({ userId, botId: value.botId, displayName: value.displayName, createdAt: now, updatedAt: now })
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

    readonly saveAccessToken = async (
        userId: string,
        botId: string,
        accessTokenId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .insert(chatAccessToken)
            .values({
                accessTokenId: v.parse(identifier, accessTokenId),
                userId,
                botId: v.parse(identifier, botId),
                createdAt: now,
            })
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly ownsAccessToken = async (userId: string, accessTokenId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ accessTokenId: chatAccessToken.accessTokenId })
            .from(chatAccessToken)
            .where(
                and(
                    eq(chatAccessToken.userId, userId),
                    eq(chatAccessToken.accessTokenId, v.parse(identifier, accessTokenId)),
                ),
            )
            .get();
        signal.throwIfAborted();
        return result !== undefined;
    };

    readonly accessTokenBot = async (
        userId: string,
        accessTokenId: string,
        signal: AbortSignal,
    ): Promise<string | null> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: chatAccessToken.botId })
            .from(chatAccessToken)
            .where(
                and(
                    eq(chatAccessToken.userId, userId),
                    eq(chatAccessToken.accessTokenId, v.parse(identifier, accessTokenId)),
                ),
            )
            .get();
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
            .delete(chatAccessToken)
            .where(
                and(
                    eq(chatAccessToken.userId, userId),
                    eq(chatAccessToken.accessTokenId, v.parse(identifier, accessTokenId)),
                ),
            )
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly listSessions = async (userId: string, signal: AbortSignal): Promise<readonly ChatSessionRecord[]> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ botId: chatSession.botId, sessionId: chatSession.sessionId, title: chatSession.title })
            .from(chatSession)
            .where(eq(chatSession.userId, userId))
            .orderBy(desc(chatSession.updatedAt));
        signal.throwIfAborted();
        return v.parse(v.array(chatSessionSchema), result);
    };

    readonly saveSession = async (
        userId: string,
        session: ChatSessionRecord,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const value = v.parse(chatSessionSchema, session);
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const result = await database
            .insert(chatSession)
            .select(
                database
                    .select({
                        userId: sql<string>`${userId}`.as("user_id"),
                        sessionId: sql<string>`${value.sessionId}`.as("session_id"),
                        botId: sql<string>`${value.botId}`.as("bot_id"),
                        title: sql<string>`${value.title}`.as("title"),
                        createdAt: sql<number>`${now}`.as("created_at"),
                        updatedAt: sql<number>`${now}`.as("updated_at"),
                    })
                    .from(sql`(select 1)`)
                    .where(
                        exists(
                            database
                                .select({ botId: managedBot.botId })
                                .from(managedBot)
                                .where(and(eq(managedBot.userId, userId), eq(managedBot.botId, value.botId))),
                        ),
                    ),
            )
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
            .update(chatSession)
            .set({ title: v.parse(titleSchema, title), updatedAt: now })
            .where(and(eq(chatSession.userId, userId), eq(chatSession.sessionId, v.parse(identifier, sessionId))))
            .run();
        signal.throwIfAborted();
        return result.meta.changes === 1;
    };

    readonly deleteSession = async (userId: string, sessionId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .delete(chatSession)
            .where(and(eq(chatSession.userId, userId), eq(chatSession.sessionId, v.parse(identifier, sessionId))))
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
