import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./index.ts";

export type Database = DrizzleD1Database<typeof schema>;

function isDatabase(value: unknown): value is D1Database {
    return (
        typeof value === "object" &&
        value !== null &&
        "prepare" in value &&
        typeof value.prepare === "function" &&
        "batch" in value &&
        typeof value.batch === "function"
    );
}

export function createDatabase(value: unknown): Database | null {
    return isDatabase(value) ? drizzle(value, { schema }) : null;
}
