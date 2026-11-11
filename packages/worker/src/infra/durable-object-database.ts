import { applyDurableObjectMigrations } from "@morty-build/relay/durable-object-migrations";
import { computerDurableObjectMigrations } from "../generated/project-do-migrations.ts";

type BoundValue = ArrayBuffer | string | number | null;

function boundValue(value: unknown): BoundValue {
    if (value instanceof ArrayBuffer) {
        return value;
    }
    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    throw new TypeError("Unsupported SQL binding.");
}

class DurableObjectStatement {
    readonly #query: string;
    readonly #sql: SqlStorage;
    readonly #values: readonly BoundValue[];

    constructor(sql: SqlStorage, query: string, values: readonly BoundValue[] = []) {
        this.#sql = sql;
        this.#query = query;
        this.#values = values;
    }

    readonly bind = (...values: readonly unknown[]) =>
        new DurableObjectStatement(this.#sql, this.#query, values.map(boundValue));

    readonly first = async (column?: string): Promise<unknown> => {
        const row = this.#sql.exec(this.#query, ...this.#values).toArray()[0] ?? null;
        return row !== null && column !== undefined ? (row[column] ?? null) : row;
    };

    readonly all = async () => ({ results: this.#sql.exec(this.#query, ...this.#values).toArray(), success: true });

    readonly raw = async () =>
        this.#sql
            .exec(this.#query, ...this.#values)
            .toArray()
            .map((row) => Object.values(row));

    readonly run = async () => this.runSynchronously();

    readonly runSynchronously = () => {
        const cursor = this.#sql.exec(this.#query, ...this.#values);
        cursor.toArray();
        const { changes } = this.#sql.exec<{ changes: number }>("SELECT changes() AS changes").one();
        return { meta: { changes }, success: true };
    };
}

export class DurableObjectDatabase {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations, "chat/");
    }

    readonly prepare = (query: string) => new DurableObjectStatement(this.#storage.sql, query);

    readonly batch = async (statements: readonly DurableObjectStatement[]) =>
        this.#storage.transactionSync(() => statements.map((statement) => statement.runSynchronously()));
}
