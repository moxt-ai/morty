import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { d1DatabaseBindingSchema } from "../../infra/cloud-bindings.ts";
import * as schema from "./index.ts";

export type Database = DrizzleD1Database<typeof schema>;

export function createDatabase(value: unknown): Database | null {
    const parsed = v.safeParse(d1DatabaseBindingSchema, value);
    return parsed.success ? drizzle(parsed.output, { schema }) : null;
}
