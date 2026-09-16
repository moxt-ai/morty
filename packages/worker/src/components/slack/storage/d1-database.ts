interface DatabaseMetricsLogger {
    readonly info: (bindings: Readonly<Record<string, unknown>>, message: string) => void;
}

export class D1SqlDatabase {
    readonly batch = async (
        statements: readonly {
            readonly query: string;
            readonly values: readonly unknown[];
        }[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#measure("batch", statements.length, async () => {
            await this.#database.batch(
                statements.map((statement) => this.#database.prepare(statement.query).bind(...statement.values)),
            );
            signal.throwIfAborted();
        });
    };
    readonly #database: D1Database;
    readonly #metrics: DatabaseMetricsLogger;
    readonly #nowMilliseconds: () => number;
    constructor(cx: {
        readonly database: D1Database;
        readonly metrics: DatabaseMetricsLogger;
        readonly nowMilliseconds: () => number;
    }) {
        this.#database = cx.database;
        this.#metrics = cx.metrics;
        this.#nowMilliseconds = cx.nowMilliseconds;
    }
    readonly first = async (query: string, values: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        return await this.#measure("first", 1, async () => {
            const result = await this.#database
                .prepare(query)
                .bind(...values)
                .first();
            signal.throwIfAborted();
            return result;
        });
    };
    readonly run = async (
        query: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ): Promise<{ readonly meta: { readonly changes: number } }> => {
        signal.throwIfAborted();
        return await this.#measure("run", 1, async () => {
            const result = await this.#database
                .prepare(query)
                .bind(...values)
                .run();
            signal.throwIfAborted();
            return result;
        });
    };

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
