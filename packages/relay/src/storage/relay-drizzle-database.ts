import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "../schema/d1/index.ts";

export type RelayDrizzleDatabase = DrizzleD1Database<typeof schema>;

export function computerDirectoryDrizzle(database: D1Database): RelayDrizzleDatabase {
    return drizzle(database, { schema });
}
