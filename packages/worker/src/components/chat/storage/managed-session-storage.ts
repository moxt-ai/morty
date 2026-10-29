import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { chatManagedSession, chatSessionOwnership } from "../../../schema/project-do/index.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";

const summarySchema = v.pipe(
    v.object({
        createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        projectId: platformIdentifier,
        userId: platformIdentifier,
        id: platformIdentifier,
    }),
    v.readonly(),
);

export class ManagedSessionStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Database => {
        const database = createDatabase(this.#database);
        if (database === null) {
            throw new PlatformProjectError("DATABASE_UNAVAILABLE", "Chat storage is unavailable.", 503);
        }
        return database;
    };

    readonly list = async (projectId: string, userId: string, botId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({
                createdAt: chatManagedSession.createdAt,
                projectId: chatManagedSession.projectId,
                userId: chatManagedSession.userId,
                id: chatManagedSession.sessionId,
            })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                ),
            )
            .orderBy(desc(chatManagedSession.createdAt), chatManagedSession.sessionId);
        signal.throwIfAborted();
        return v.parse(v.array(summarySchema), result);
    };

    readonly save = async (
        projectId: string,
        userId: string,
        botId: string,
        record: { readonly id: string },
        signal: AbortSignal,
    ) => {
        const value = v.parse(summarySchema, {
            ...record,
            createdAt: Date.now(),
            projectId,
            userId,
        });
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(chatManagedSession)
            .values({
                projectId: value.projectId,
                userId: value.userId,
                botId,
                sessionId: value.id,
                createdAt: value.createdAt,
            })
            .onConflictDoNothing()
            .run();
        signal.throwIfAborted();
    };

    readonly ownsSession = async (
        projectId: string,
        userId: string,
        botId: string,
        id: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ id: chatManagedSession.sessionId })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                    eq(chatManagedSession.sessionId, v.parse(platformIdentifier, id)),
                ),
            )
            .get();
        signal.throwIfAborted();
        if (result !== undefined) {
            return true;
        }
        const retained = await this.#requireDatabase()
            .select({ id: chatSessionOwnership.sessionId })
            .from(chatSessionOwnership)
            .where(
                and(
                    eq(chatSessionOwnership.projectId, projectId),
                    eq(chatSessionOwnership.userId, userId),
                    eq(chatSessionOwnership.botId, botId),
                    eq(chatSessionOwnership.sessionId, v.parse(platformIdentifier, id)),
                ),
            )
            .get();
        signal.throwIfAborted();
        return retained !== undefined;
    };

    readonly archive = async (
        projectId: string,
        userId: string,
        botId: string,
        id: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const database = this.#requireDatabase();
        const sessionId = v.parse(platformIdentifier, id);
        // Keep the recent-list representation unchanged for older Workers and supported rollback.
        await database.batch([
            database.insert(chatSessionOwnership).values({ projectId, userId, botId, sessionId }).onConflictDoNothing(),
            database
                .delete(chatManagedSession)
                .where(
                    and(
                        eq(chatManagedSession.projectId, projectId),
                        eq(chatManagedSession.userId, userId),
                        eq(chatManagedSession.botId, botId),
                        eq(chatManagedSession.sessionId, sessionId),
                    ),
                ),
        ]);
        signal.throwIfAborted();
    };
}
