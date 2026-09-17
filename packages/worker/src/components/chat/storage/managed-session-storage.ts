import * as v from "valibot";
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

function isDatabase(value: unknown): value is Pick<D1Database, "prepare"> {
    return typeof value === "object" && value !== null && "prepare" in value && typeof value.prepare === "function";
}

export class ManagedSessionStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #prepare = (query: string) => {
        const database = this.#database;
        if (!isDatabase(database)) {
            throw new PlatformProjectError("DATABASE_UNAVAILABLE", "Chat storage is unavailable.", 503);
        }
        return database.prepare(query);
    };

    readonly list = async (projectId: string, userId: string, botId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = await this.#prepare(
            "SELECT project_id AS projectId, user_id AS userId, kind, resource_id AS id, title FROM chat_managed_session WHERE project_id = ? AND user_id = ? AND bot_id = ? ORDER BY created_at DESC, resource_id",
        )
            .bind(projectId, userId, botId)
            .all();
        signal.throwIfAborted();
        return v.parse(v.array(summarySchema), result.results);
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
        await this.#prepare(
            "INSERT INTO chat_managed_session (project_id, user_id, bot_id, kind, resource_id, title, fork_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, user_id, bot_id, kind, resource_id) DO NOTHING",
        )
            .bind(
                value.projectId,
                value.userId,
                botId,
                value.kind,
                value.id,
                value.title,
                record.kind === "conversation" ? null : record.data,
                Date.now(),
            )
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
        const result = await this.#prepare(
            "SELECT fork_data AS data FROM chat_managed_session WHERE project_id = ? AND user_id = ? AND bot_id = ? AND kind IN ('fork', 'import') AND resource_id = ?",
        )
            .bind(projectId, userId, botId, v.parse(platformIdentifier, id))
            .first();
        signal.throwIfAborted();
        if (result === null) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        const data: unknown = JSON.parse(v.parse(v.object({ data: v.string() }), result).data);
        return data;
    };
}
