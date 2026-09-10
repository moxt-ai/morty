import { createServer } from "node:http";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../packages/worker/src/application.ts";

// Stateful external service: owns credentials, project records, and authorization.
// Cloud reaches it over a real HTTP socket, without an embedded Mobius runtime.
async function service() {
    const projects = new Map<string, string[]>();
    const tenants = new Map([
        ["Bearer alice", "team-a"],
        ["Bearer bob", "team-b"],
    ]);
    const server = createServer(async (request, response) => {
        if (request.url === "/mobius/api/redirect") {
            response.writeHead(302, { location: "https://untrusted.example/" });
            response.end();
            return;
        }
        const tenant = tenants.get(request.headers.authorization ?? "");
        if (!tenant) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }));
            return;
        }
        if (request.headers.cookie || request.headers["x-tenant-id"]) {
            response.writeHead(400);
            response.end();
            return;
        }
        if (request.url === "/mobius/api/events") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(`event: projects\ndata: ${JSON.stringify(projects.get(tenant) ?? [])}\n\n`);
            return;
        }
        if (request.method === "POST") {
            let text = "";
            for await (const chunk of request) {
                text += chunk;
            }
            const input = v.safeParse(v.object({ name: v.string() }), JSON.parse(text));
            if (!input.success) {
                response.writeHead(400);
                response.end();
                return;
            }
            projects.set(tenant, [...(projects.get(tenant) ?? []), input.output.name]);
        }
        response.writeHead(request.method === "POST" ? 201 : 200, {
            "content-type": "application/json",
            "cache-control": "no-store",
        });
        response.end(JSON.stringify({ projects: projects.get(tenant) ?? [] }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing service address");
    }
    return {
        bindings: { MOBIUS_BASE_URL: `http://127.0.0.1:${address.port}` },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

test("Given an external Mobius service, When a Cloud user saves a project and reads its events, Then HTTP requests preserve their service authorization and tenant isolation", async () => {
    const upstream = await service();
    try {
        const saved = await worker.fetch(
            new Request("https://cloud.test/mobius/api/v1/projects", {
                method: "POST",
                headers: {
                    authorization: "Bearer alice",
                    "content-type": "application/json",
                    cookie: "session=private",
                    "x-tenant-id": "team-b",
                },
                body: JSON.stringify({ name: "Research" }),
            }),
            upstream.bindings,
        );
        expect(saved.status).toBe(201);
        expect(await saved.json()).toEqual({ projects: ["Research"] });
        const other = await worker.fetch(
            new Request("https://cloud.test/mobius/api/v1/projects", { headers: { authorization: "Bearer bob" } }),
            upstream.bindings,
        );
        expect(await other.json()).toEqual({ projects: [] });
        const events = await worker.fetch(
            new Request("https://cloud.test/mobius/api/events", { headers: { authorization: "Bearer alice" } }),
            upstream.bindings,
        );
        expect(events.headers.get("content-type")).toBe("text/event-stream");
        expect(await events.text()).toContain('data: ["Research"]');
        const anonymous = await worker.fetch(
            new Request("https://cloud.test/mobius/api/v1/projects"),
            upstream.bindings,
        );
        expect(anonymous.status).toBe(401);
        expect(await anonymous.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
    } finally {
        await upstream.close();
    }
});
test("Given missing or recursive Mobius configuration, When a user opens projects, Then Cloud reports an unavailable service without forwarding", async () => {
    for (const MOBIUS_BASE_URL of [
        undefined,
        "https://cloud.test",
        "https://user:secret@mobius.test",
        "https://mobius.test/other",
    ]) {
        const response = await worker.fetch(
            new Request("https://cloud.test/mobius/api/v1/projects"),
            MOBIUS_BASE_URL === undefined ? {} : { MOBIUS_BASE_URL },
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "MOBIUS_UNAVAILABLE" } });
    }
});
test("Given a redirect from Mobius, When Cloud receives the response, Then credentials are not sent to the redirect target", async () => {
    const upstream = await service();
    try {
        const response = await worker.fetch(
            new Request("https://cloud.test/mobius/api/redirect", { headers: { authorization: "Bearer alice" } }),
            upstream.bindings,
        );
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { code: "MOBIUS_BAD_GATEWAY" } });
    } finally {
        await upstream.close();
    }
});
