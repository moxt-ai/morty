import { eq } from "drizzle-orm";
import type { HttpError } from "../../../infra/http-error.ts";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { managedBot } from "../../../schema/project-do/index.ts";

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

    /** Whether this Project's owner has its Machine. */
    readonly hasMachine = async (userId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const row = await this.#requireDatabase()
            .select({ userId: managedBot.userId })
            .from(managedBot)
            .where(eq(managedBot.userId, userId))
            .get();
        signal.throwIfAborted();
        return row !== undefined;
    };

    /**
     * Gives the owner its Machine unless it already has one: the owner is the key, so a repeated or concurrent claim
     * never adds a second one.
     */
    readonly claimMachine = async (userId: string, now: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.#requireDatabase()
            .insert(managedBot)
            .values({ userId, createdAt: now })
            .onConflictDoNothing({ target: managedBot.userId })
            .run();
        if (!(await this.hasMachine(userId, signal))) {
            throw new ManagementStorageError("DATABASE_UNAVAILABLE", "The Machine could not be stored.");
        }
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
