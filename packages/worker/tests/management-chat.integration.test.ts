import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, IdentityProvider } from "./support/identity-provider.ts";

const issuer = new IdentityProvider();

class InMemoryD1Statement {
    readonly #query: string;
    readonly #database: DatabaseSync;
    readonly #values: readonly SQLInputValue[];
    constructor(query: string, database: DatabaseSync, values: readonly SQLInputValue[] = []) {
        this.#query = query;
        this.#database = database;
        this.#values = values;
    }
    readonly bind = (...values: readonly unknown[]) =>
        new InMemoryD1Statement(
            this.#query,
            this.#database,
            values.map((value) => v.parse(v.union([v.string(), v.number(), v.null()]), value)),
        );
    readonly first = async () => this.#database.prepare(this.#query).get(...this.#values) ?? null;
    readonly all = async () => ({ results: this.#database.prepare(this.#query).all(...this.#values), success: true });
    readonly run = async () => {
        const result = this.#database.prepare(this.#query).run(...this.#values);
        return { meta: { changes: Number(result.changes) } };
    };
}

class InMemoryD1Database {
    readonly #database = new DatabaseSync(":memory:");
    constructor() {
        this.#database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    }
    readonly close = () => this.#database.close();
    readonly prepare = (query: string) => new InMemoryD1Statement(query, this.#database);
}

interface UpstreamCall {
    readonly authorization: string | undefined;
    readonly appId: string | undefined;
    readonly appSecret: string | undefined;
    readonly method: string | undefined;
    readonly path: string | undefined;
}

async function mobiusService() {
    const calls: UpstreamCall[] = [];
    let issued = 0;
    const server = createServer(async (request, response) => {
        calls.push({
            authorization: request.headers.authorization,
            appId: request.headers["x-mobius-app-id"] as string | undefined,
            appSecret: request.headers["x-mobius-app-secret"] as string | undefined,
            method: request.method,
            path: request.url,
        });
        if (request.method === "POST" && request.url === "/mobius/api/v1/access-tokens") {
            issued += 1;
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ accessTokenId: `key-${issued}`, accessToken: `virtual-${issued}` }));
            return;
        }
        if (request.method === "POST" && request.url === "/mobius/api/v1/access-tokens/key-2/regenerate") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ accessTokenId: "key-2", accessToken: "regenerated-2" }));
            return;
        }
        if (request.method === "DELETE" && request.url?.startsWith("/mobius/api/v1/access-tokens/")) {
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(404);
        response.end();
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
        calls,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

const databases: InMemoryD1Database[] = [];
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});
afterEach(() => {
    for (const database of databases.splice(0)) {
        database.close();
    }
    vi.useRealTimers();
});

test("Given a signed-in user with an owner credential, When they claim a bot, Then management records only their ownership and revokes the proof key", async () => {
    const mobius = await mobiusService();
    const database = new InMemoryD1Database();
    databases.push(database);
    const bindings = {
        APP_ORIGIN,
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        DATABASE: database,
        MOBIUS_APP_ID: "cloud-app",
        MOBIUS_APP_SECRET: "cloud-secret",
        MOBIUS_BASE_URL: mobius.baseUrl,
    };
    try {
        const aliceToken = issuer.createSession("user_alice");
        const claim = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/management/bots/claims", {
                method: "POST",
                headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
                body: JSON.stringify({ botId: "bot-one", displayName: "Research", ownerCredential: "o".repeat(32) }),
            }),
            bindings,
        );
        expect(claim.status).toBe(201);
        expect(await claim.json()).toEqual({ botId: "bot-one", displayName: "Research" });
        const alice = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/management/bots", {
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(await alice.json()).toEqual({ bots: [{ botId: "bot-one", displayName: "Research" }] });
        const bob = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/management/bots", {
                headers: { authorization: `Bearer ${issuer.createSession("user_bob")}` },
            }),
            bindings,
        );
        expect(await bob.json()).toEqual({ bots: [] });
        expect(mobius.calls).toEqual([
            {
                authorization: `Bearer ${"o".repeat(32)}`,
                appId: "cloud-app",
                appSecret: "cloud-secret",
                method: "POST",
                path: "/mobius/api/v1/access-tokens",
            },
            {
                authorization: undefined,
                appId: "cloud-app",
                appSecret: "cloud-secret",
                method: "DELETE",
                path: "/mobius/api/v1/access-tokens/key-1",
            },
        ]);
    } finally {
        await mobius.close();
    }
});

test("Given a user-owned bot, When chat access and session records are managed, Then keys are revocable and sessions remain user-scoped", async () => {
    const mobius = await mobiusService();
    const database = new InMemoryD1Database();
    databases.push(database);
    const bindings = {
        APP_ORIGIN,
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        DATABASE: database,
        MOBIUS_APP_ID: "cloud-app",
        MOBIUS_APP_SECRET: "cloud-secret",
        MOBIUS_BASE_URL: mobius.baseUrl,
    };
    const aliceToken = issuer.createSession("user_alice");
    try {
        await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/management/bots/claims", {
                method: "POST",
                headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
                body: JSON.stringify({ botId: "bot-one", displayName: "Research", ownerCredential: "o".repeat(32) }),
            }),
            bindings,
        );
        mobius.calls.splice(0);
        const access = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/bots/bot-one/access-tokens", {
                method: "POST",
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(access.status).toBe(201);
        expect(await access.json()).toEqual({
            accessToken: "virtual-2",
            accessTokenId: "key-2",
        });
        expect(mobius.calls.map(({ authorization, method, path }) => ({ authorization, method, path }))).toEqual([
            { authorization: undefined, method: "POST", path: "/mobius/api/v1/access-tokens" },
        ]);
        const regenerated = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/management/access-tokens/key-2/regenerate", {
                method: "POST",
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(await regenerated.json()).toEqual({
            accessToken: "regenerated-2",
            accessTokenId: "key-2",
        });
        expect(mobius.calls.at(-1)).toMatchObject({
            authorization: undefined,
            method: "POST",
            path: "/mobius/api/v1/access-tokens/key-2/regenerate",
        });

        const created = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/sessions", {
                method: "POST",
                headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
                body: JSON.stringify({ botId: "bot-one", sessionId: "session-one", title: "Planning" }),
            }),
            bindings,
        );
        expect(created.status).toBe(201);
        const renamed = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/sessions/session-one", {
                method: "PATCH",
                headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
                body: JSON.stringify({ title: "Project planning" }),
            }),
            bindings,
        );
        expect(renamed.status).toBe(200);
        const sessions = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/sessions", {
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(await sessions.json()).toEqual({
            sessions: [{ botId: "bot-one", sessionId: "session-one", title: "Project planning" }],
        });

        const forbidden = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/sessions/session-one", {
                method: "DELETE",
                headers: { authorization: `Bearer ${issuer.createSession("user_bob")}` },
            }),
            bindings,
        );
        expect(forbidden.status).toBe(404);
        const deleted = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/sessions/session-one", {
                method: "DELETE",
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(deleted.status).toBe(204);

        const revoked = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/chat/access-tokens/key-2", {
                method: "DELETE",
                headers: { authorization: `Bearer ${aliceToken}` },
            }),
            bindings,
        );
        expect(revoked.status).toBe(204);
        expect(mobius.calls.at(-1)).toMatchObject({
            authorization: undefined,
            method: "DELETE",
            path: "/mobius/api/v1/access-tokens/key-2",
        });
    } finally {
        await mobius.close();
    }
});
