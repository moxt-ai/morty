import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { chatManagedSession } from "../../../schema/project-do/index.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";

const summarySchema = v.pipe(
    v.object({
        projectId: platformIdentifier,
        userId: platformIdentifier,
        id: platformIdentifier,
        title: v.pipe(v.string(), v.maxLength(500)),
        directoryId: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
        additionalDirectoryIds: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))),
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
                projectId: chatManagedSession.projectId,
                userId: chatManagedSession.userId,
                id: chatManagedSession.resourceId,
                title: chatManagedSession.title,
                directoryId: chatManagedSession.directoryId,
                additionalDirectoryIdsJson: chatManagedSession.additionalDirectoryIdsJson,
            })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                ),
            )
            .orderBy(desc(chatManagedSession.createdAt), chatManagedSession.resourceId);
        signal.throwIfAborted();
        return v.parse(
            v.array(summarySchema),
            result.map((row) => {
                const additionalDirectoryIds: unknown = JSON.parse(row.additionalDirectoryIdsJson);
                return { ...row, additionalDirectoryIds };
            }),
        );
    };

    readonly save = async (
        projectId: string,
        userId: string,
        botId: string,
        record: {
            readonly id: string;
            readonly title: string;
            readonly directoryId?: string;
            readonly additionalDirectoryIds?: readonly string[];
        },
        signal: AbortSignal,
    ) => {
        const value = v.parse(summarySchema, {
            ...record,
            directoryId: record.directoryId ?? "default",
            additionalDirectoryIds: record.additionalDirectoryIds ?? [],
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
                resourceId: value.id,
                title: value.title,
                directoryId: value.directoryId,
                additionalDirectoryIdsJson: JSON.stringify(value.additionalDirectoryIds),
                createdAt: Date.now(),
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
            .select({ id: chatManagedSession.resourceId })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                    eq(chatManagedSession.resourceId, v.parse(platformIdentifier, id)),
                ),
            )
            .get();
        signal.throwIfAborted();
        return result !== undefined;
    };
}
