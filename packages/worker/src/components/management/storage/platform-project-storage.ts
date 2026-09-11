import * as v from "valibot";
import { type PlatformProject, PlatformProjectError, platformProjectSchema } from "../entity/platform-project.ts";

function isDatabase(value: unknown): value is Pick<D1Database, "prepare"> {
    return typeof value === "object" && value !== null && "prepare" in value && typeof value.prepare === "function";
}

export class PlatformProjectStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = () => {
        if (!isDatabase(this.#database)) {
            throw new PlatformProjectError("DATABASE_UNAVAILABLE", "Project storage is unavailable.", 503);
        }
        return this.#database;
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
                .prepare(
                    "SELECT project_id AS projectId, display_name AS displayName FROM platform_project_mapping WHERE user_id = ? AND platform_origin = ? AND app_id = ?",
                )
                .bind(userId, origin, appId)
                .first();
            signal.throwIfAborted();
            return v.parse(v.nullable(platformProjectSchema), value);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Project storage is unavailable.", 503, {
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
                .prepare(
                    "INSERT INTO platform_project_mapping (user_id, platform_origin, app_id, project_id, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, platform_origin, app_id) DO NOTHING",
                )
                .bind(userId, origin, appId, value.projectId, value.displayName, Date.now())
                .run();
            signal.throwIfAborted();
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformProjectError("PROJECT_STORAGE_UNAVAILABLE", "Project storage is unavailable.", 503, {
                cause,
            });
        }
    };
}
