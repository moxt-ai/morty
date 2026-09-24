import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { chatManagedSession } from "../../../schema/project-do/index.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";

const ownershipSchema = v.pipe(v.object({ isExternal: v.boolean(), id: platformIdentifier }), v.readonly());

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
            .select({ isExternal: chatManagedSession.isExternal, id: chatManagedSession.resourceId })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                    isNull(chatManagedSession.archivedAt),
                ),
            )
            .orderBy(desc(chatManagedSession.createdAt), chatManagedSession.resourceId);
        signal.throwIfAborted();
        return v.parse(v.array(ownershipSchema), result);
    };

    readonly archive = async (
        projectId: string,
        userId: string,
        botId: string,
        id: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const archived = await this.#requireDatabase()
            .update(chatManagedSession)
            .set({ archivedAt: Date.now() })
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                    eq(chatManagedSession.resourceId, v.parse(platformIdentifier, id)),
                    isNull(chatManagedSession.archivedAt),
                ),
            )
            .returning({ id: chatManagedSession.resourceId })
            .get();
        signal.throwIfAborted();
        if (archived === undefined) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
    };

    readonly save = async (
        projectId: string,
        userId: string,
        botId: string,
        record: { readonly isExternal: boolean; readonly id: string },
        signal: AbortSignal,
    ): Promise<void> => {
        const value = v.parse(ownershipSchema, record);
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(chatManagedSession)
            .values({
                projectId: v.parse(platformIdentifier, projectId),
                userId: v.parse(platformIdentifier, userId),
                botId: v.parse(platformIdentifier, botId),
                isExternal: value.isExternal,
                resourceId: value.id,
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
