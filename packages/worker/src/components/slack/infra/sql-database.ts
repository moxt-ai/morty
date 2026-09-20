import type { Database } from "../../../schema/d1/database.ts";

export interface SqlDatabase {
    readonly execute: <T>(
        operation: "batch" | "first" | "run",
        queryCount: number,
        signal: AbortSignal,
        query: (database: Database) => Promise<T>,
    ) => Promise<T>;
}
