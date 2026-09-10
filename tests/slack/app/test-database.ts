import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { afterEach, beforeEach, vi } from "vitest";

class TestDatabase {
    readonly batch = async (
        statements: readonly {
            readonly query: string;
            readonly values: readonly unknown[];
        }[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.sqlite.exec("BEGIN");
        try {
            for (const statement of statements) {
                this.sqlite
                    .prepare(statement.query)
                    .run(
                        ...statement.values.map((value) =>
                            v.parse(v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]), value),
                        ),
                    );
            }
            this.sqlite.exec("COMMIT");
        } catch (error) {
            this.sqlite.exec("ROLLBACK");
            throw error;
        }
    };
    readonly sqlite = new DatabaseSync(":memory:");
    constructor() {
        this.sqlite.exec(
            readFileSync(new URL("../../../packages/worker/migrations/0001_initial.sql", import.meta.url), "utf8"),
        );
    }
    readonly first = async (query: string, values: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        return (
            this.sqlite
                .prepare(query)
                .get(
                    ...values.map((value) =>
                        v.parse(v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]), value),
                    ),
                ) ?? null
        );
    };
    readonly run = async (query: string, values: readonly unknown[], signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = this.sqlite
            .prepare(query)
            .run(
                ...values.map((value) =>
                    v.parse(v.union([v.string(), v.pipe(v.number(), v.finite()), v.null()]), value),
                ),
            );
        return { meta: { changes: Number(result.changes) } };
    };
}

const databases: TestDatabase[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
    for (const db of databases.splice(0)) {
        db.sqlite.close();
    }
    vi.useRealTimers();
});

export function createTestDatabase(): TestDatabase {
    const database = new TestDatabase();
    databases.push(database);
    return database;
}
