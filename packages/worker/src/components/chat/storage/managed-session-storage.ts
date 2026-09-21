import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/d1/database.ts";
import { chatManagedSession } from "../../../schema/project-do/index.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";

const summarySchema = v.pipe(
    v.object({
        projectId: platformIdentifier,
        userId: platformIdentifier,
        kind: v.picklist(["conversation", "fork", "import"]),
        id: platformIdentifier,
        title: v.pipe(v.string(), v.maxLength(500)),
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
                kind: chatManagedSession.kind,
                id: chatManagedSession.resourceId,
                title: chatManagedSession.title,
            })
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
        return v.parse(v.array(summarySchema), result);
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
        record:
            | { readonly kind: "conversation"; readonly id: string; readonly title: string }
            | {
                  readonly kind: "fork" | "import";
                  readonly id: string;
                  readonly title: string;
                  readonly data: string;
              },
        signal: AbortSignal,
    ) => {
        const value = v.parse(summarySchema, { ...record, projectId, userId });
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(chatManagedSession)
            .values({
                projectId: value.projectId,
                userId: value.userId,
                botId,
                kind: value.kind,
                resourceId: value.id,
                title: value.title,
                forkData: record.kind === "conversation" ? null : record.data,
                createdAt: Date.now(),
            })
            .onConflictDoNothing()
            .run();
        signal.throwIfAborted();
    };

    readonly readLocalSession = async (
        projectId: string,
        userId: string,
        botId: string,
        id: string,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ data: chatManagedSession.forkData })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.projectId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.botId, botId),
                    inArray(chatManagedSession.kind, ["fork", "import"]),
                    eq(chatManagedSession.resourceId, v.parse(platformIdentifier, id)),
                ),
            )
            .get();
        signal.throwIfAborted();
        if (result === undefined) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        const data: unknown = JSON.parse(v.parse(v.object({ data: v.string() }), result).data);
        return data;
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
