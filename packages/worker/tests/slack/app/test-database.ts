import { readdir, readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/d1";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, vi } from "vitest";
import type { SqlDatabase } from "../../../src/components/slack/infra/sql-database.ts";
import { D1SqlDatabase } from "../../../src/components/slack/storage/d1-database.ts";
import type { Database } from "../../../src/schema/d1/database.ts";
import * as schema from "../../../src/schema/d1/index.ts";

class TestDatabase implements SqlDatabase {
    readonly binding: D1Database;
    readonly orm: Database;
    readonly execute: SqlDatabase["execute"];
    readonly #runtime: Miniflare;

    constructor(runtime: Miniflare, d1: D1Database) {
        this.#runtime = runtime;
        this.binding = d1;
        this.orm = drizzle(d1, { schema });
        this.execute = new D1SqlDatabase({
            database: d1,
            metrics: { info: () => undefined },
            nowMilliseconds: () => performance.now(),
        }).execute;
    }

    readonly dispose = async (): Promise<void> => {
        await this.#runtime.dispose();
    };
}

const databases: TestDatabase[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
});
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(databases.splice(0).map(async (database) => await database.dispose()));
});

export async function createTestDatabase(): Promise<TestDatabase> {
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            compatibilityDate: "2026-09-07",
            d1Databases: ["DATABASE"],
            modules: true,
            script: "export default { fetch() { return new Response(); } }",
        }),
    );
    const d1 = await runtime.getD1Database("DATABASE");
    const migrationDirectory = new URL("../../../migrations/d1/", import.meta.url);
    const migrationNames = (await readdir(migrationDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
        .map((entry) => entry.name)
        .sort();
    const migrations = await Promise.all(
        migrationNames.map(async (name) => await readFile(new URL(name, migrationDirectory), "utf8")),
    );
    const statements = migrations.flatMap((migration) =>
        migration
            .split(";")
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0)
            .map((statement) => d1.prepare(statement)),
    );
    await d1.batch(statements);
    const database = new TestDatabase(runtime, d1);
    databases.push(database);
    return database;
}
