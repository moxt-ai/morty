import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { platformProjectMapping } from "../../../schema/project-do/index.ts";
import { type PlatformProject, PlatformProjectError, platformProjectSchema } from "../entity/platform-project.ts";

export class PlatformProjectStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Database => {
        const database = createDatabase(this.#database);
        if (database === null) {
            throw new PlatformProjectError("DATABASE_UNAVAILABLE", "Morty storage is unavailable.", 503);
        }
        return database;
    };

    readonly read = async (
        userId: string,
        origin: string,
        appId: string,
        signal: AbortSignal,
    ): Promise<PlatformProject | null> => {
        signal.throwIfAborted();
        try {
            const value = await this.#requireDatabase()
                .select({
                    projectId: platformProjectMapping.projectId,
                    displayName: platformProjectMapping.displayName,
                })
                .from(platformProjectMapping)
                .where(
                    and(
                        eq(platformProjectMapping.userId, userId),
                        eq(platformProjectMapping.platformOrigin, origin),
                        eq(platformProjectMapping.appId, appId),
                    ),
                )
                .get();
            signal.throwIfAborted();
            return v.parse(v.nullish(platformProjectSchema), value) ?? null;
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Morty storage is unavailable.", 503, {
                cause,
            });
        }
    };

    readonly save = async (
        userId: string,
        origin: string,
        appId: string,
        project: PlatformProject,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        try {
            const value = v.parse(platformProjectSchema, project);
            await this.#requireDatabase()
                .insert(platformProjectMapping)
                .values({
                    userId,
                    platformOrigin: origin,
                    appId,
                    projectId: value.projectId,
                    displayName: value.displayName,
                    createdAt: Date.now(),
                })
                .onConflictDoNothing()
                .run();
            signal.throwIfAborted();
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Morty storage is unavailable.", 503, {
                cause,
            });
        }
    };
}
