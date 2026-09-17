import { createServer } from "node:http";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { MobiusAppService } from "../src/components/chat/service/mobius-app-service.ts";
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

test("Given a Mobius Chat gateway request, When Mobius responds, Then operators receive its performance metric", async () => {
    const server = createServer((_request, response) => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ accessToken: "credential", accessTokenId: "token-1" }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected the Mobius test server address");
        }
        const metrics = new CapturedMetrics();
        const gateway = new MobiusAppService({
            appId: "app-1",
            appSecret: "secret",
            baseUrl: `http://127.0.0.1:${address.port}`,
            forbiddenOrigin: "https://chat.example.test",
            metrics,
            nowMilliseconds: sequenceClock([100, 127]),
        });

        await expect(gateway.issueAccessToken("bot-1", null, new AbortController().signal)).resolves.toEqual({
            accessToken: "credential",
            accessTokenId: "token-1",
        });
        expect(metrics.entries).toEqual([
            {
                bindings: {
                    durationMs: 27,
                    event: "performance-metric",
                    metric: "mobius-chat-gateway-request-duration",
                    operation: "issue-access-token",
                    outcome: "success",
                },
                message: "Performance metric",
            },
        ]);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});

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

        await expect(measured.first("SELECT value FROM example", [], new AbortController().signal)).resolves.toEqual({
            value: "stored",
        });
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
