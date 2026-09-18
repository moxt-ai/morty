import { sql } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { D1SqlDatabase } from "../src/components/slack/storage/d1-database.ts";

class CapturedMetrics {
    readonly entries: Array<{
        readonly bindings: Readonly<Record<string, unknown>>;
        readonly message: string;
    }> = [];

    readonly info = (bindings: Readonly<Record<string, unknown>>, message: string): void => {
        this.entries.push({ bindings, message });
    };
}

function sequenceClock(values: readonly number[]): () => number {
    let position = 0;
    return () => {
        const value = values[position];
        if (value === undefined) {
            throw new Error("The test clock has no remaining values");
        }
        position += 1;
        return value;
    };
}

test("Given a D1 query, When the database returns, Then operators receive its performance metric", async () => {
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            compatibilityDate: "2026-09-07",
            d1Databases: ["DATABASE"],
            modules: true,
            script: "export default { fetch() { return new Response(); } }",
        }),
    );
    try {
        const database = await runtime.getD1Database("DATABASE");
        await database.prepare("CREATE TABLE example (value TEXT NOT NULL)").run();
        await database.prepare("INSERT INTO example (value) VALUES (?)").bind("stored").run();
        const metrics = new CapturedMetrics();
        const measured = new D1SqlDatabase({
            database,
            metrics,
            nowMilliseconds: sequenceClock([200, 229]),
        });

        await expect(
            measured.execute(
                "first",
                1,
                new AbortController().signal,
                async (orm) => await orm.run(sql`UPDATE example SET value = 'stored'`),
            ),
        ).resolves.toMatchObject({ meta: { changes: 1 } });
        expect(metrics.entries).toEqual([
            {
                bindings: {
                    durationMs: 29,
                    event: "performance-metric",
                    metric: "database-query-duration",
                    operation: "first",
                    outcome: "success",
                    queryCount: 1,
                },
                message: "Performance metric",
            },
        ]);
    } finally {
        await runtime.dispose();
    }
});
