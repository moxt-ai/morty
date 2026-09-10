export class D1SqlDatabase {
    readonly batch = async (
        statements: readonly {
            readonly query: string;
            readonly values: readonly unknown[];
        }[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#database.batch(
            statements.map((statement) => this.#database.prepare(statement.query).bind(...statement.values)),
        );
        signal.throwIfAborted();
    };
    readonly #database: D1Database;
    constructor(database: D1Database) {
        this.#database = database;
    }
    readonly first = async (query: string, values: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        const result = await this.#database
            .prepare(query)
            .bind(...values)
            .first();
        signal.throwIfAborted();
        return result;
    };
    readonly run = async (
        query: string,
        values: readonly unknown[],
        signal: AbortSignal,
    ): Promise<{ readonly meta: { readonly changes: number } }> => {
        signal.throwIfAborted();
        const result = await this.#database
            .prepare(query)
            .bind(...values)
            .run();
        signal.throwIfAborted();
        return result;
    };
}
