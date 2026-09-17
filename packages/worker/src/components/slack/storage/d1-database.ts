import { createDatabase, type Database } from "../../../schema/database.ts";

interface DatabaseMetricsLogger {
    readonly info: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
}

export class D1SqlDatabase {
    readonly execute = async <T>(
        operation: "batch" | "first" | "run",
        queryCount: number,
        signal: AbortSignal,
        query: (database: Database) => Promise<T>,
    ): Promise<T> => {
        signal.throwIfAborted();
        return await this.#measure(operation, queryCount, async () => {
            const result = await query(this.#database);
            signal.throwIfAborted();
            return result;
        });
    };
    readonly #database: Database;
    readonly #metrics: DatabaseMetricsLogger;
    readonly #nowMilliseconds: () => number;
    constructor(cx: {
        readonly database: D1Database;
        readonly metrics: DatabaseMetricsLogger;
        readonly nowMilliseconds: () => number;
    }) {
        const database = createDatabase(cx.database);
        if (database === null) {
            throw new TypeError("A D1 database is required.");
        }
        this.#database = database;
        this.#metrics = cx.metrics;
        this.#nowMilliseconds = cx.nowMilliseconds;
    }
    readonly #measure = async <T>(
        operation: "batch" | "first" | "run",
        queryCount: number,
        query: () => Promise<T>,
    ) => {
        const startedAt = this.#nowMilliseconds();
        let outcome: "failure" | "success" = "failure";
        try {
            const result = await query();
            outcome = "success";
            return result;
        } finally {
            this.#metrics.info(
                {
                    durationMs: this.#nowMilliseconds() - startedAt,
                    event: "performance-metric",
                    metric: "database-query-duration",
                    operation,
                    outcome,
                    queryCount,
                },
                "Performance metric",
            );
        }
    };
}
