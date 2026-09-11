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
        this.#database.exec(
            readFileSync(new URL("../migrations/0002_anonymous_identity.sql", import.meta.url), "utf8"),
        );
        this.#database.exec(readFileSync(new URL("../migrations/0003_platform_project.sql", import.meta.url), "utf8"));
    }
    readonly close = () => this.#database.close();
    readonly prepare = (query: string) => new InMemoryD1Statement(query, this.#database);
    readonly batch = async (statements: readonly InMemoryD1Statement[]) => {
        this.#database.exec("BEGIN");
        try {
            const results = [];
            for (const statement of statements) {
                results.push(await statement.run());
            }
            this.#database.exec("COMMIT");
            return results;
        } catch (cause) {
            this.#database.exec("ROLLBACK");
            throw cause;
        }
    };
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
    const projects = new Map<string, object>();
    const bots = new Map<string, object>();
    const pairings = new Map<
        string,
        {
            readonly pairingId: string;
            readonly projectId: string;
            readonly runtimeId: string;
            readonly channelId: string;
            readonly pairingCode: string;
            readonly pollToken: string;
            readonly expiresAt: string;
        }
    >();
    const appCredential = `mapp_${"a".repeat(22)}_${"b".repeat(43)}`;
    const server = createServer(async (request, response) => {
        calls.push({
            authorization: request.headers.authorization,
            appId: request.headers["x-mobius-app-id"] as string | undefined,
            appSecret: request.headers["x-mobius-app-secret"] as string | undefined,
            method: request.method,
            path: request.url,
        });
        const pairingPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/runtime-pairings(?:\/([^/]+))?$/u,
        );
        if (pairingPath !== undefined && pairingPath !== null) {
            if (request.headers.authorization !== `Bearer ${appCredential}`) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { code: "app_credential_invalid", message: "Unauthorized" } }));
                return;
            }
            const projectId = v.parse(v.string(), pairingPath[1]);
            if (request.method === "POST" && pairingPath[2] === undefined) {
                let body = "";
                for await (const chunk of request) {
                    body += chunk;
                }
                const input = v.parse(v.object({ idempotencyKey: v.string() }), JSON.parse(body));
                const key = `${projectId}:${input.idempotencyKey}`;
                let pairing = pairings.get(key);
                if (pairing === undefined) {
                    pairing = {
                        pairingId: `pair-${pairings.size + 1}`,
                        projectId,
                        runtimeId: `runtime-${pairings.size + 1}`,
                        channelId: `channel-${pairings.size + 1}`,
                        pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                        pollToken: "p".repeat(43),
                        expiresAt: new Date(AUTH_TIME.getTime() + 300000).toISOString(),
                    };
                    pairings.set(key, pairing);
                }
                response.writeHead(201, { "content-type": "application/json" });
                response.end(JSON.stringify(pairing));
                return;
            }
            const pairing = [...pairings.values()].find(
                (value) => value.projectId === projectId && value.pairingId === pairingPath[2],
            );
            response.writeHead(pairing === undefined ? 404 : 200, { "content-type": "application/json" });
            response.end(
                JSON.stringify(
                    pairing === undefined
                        ? { error: { code: "not_found", message: "Not found" } }
                        : { status: "pending", expiresAt: pairing.expiresAt },
                ),
            );
            return;
        }
        if (request.method === "POST" && request.url === "/mobius/api/v1/apps/cloud-app/projects") {
            if (
                request.headers.authorization !== `Bearer ${appCredential}` ||
                request.headers["x-mobius-oidc-provider"] !== undefined
            ) {
                response.writeHead(403, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { code: "tenant_access_denied", message: "Not authorized" } }));
                return;
            }
            let body = "";
            for await (const chunk of request) {
                body += chunk;
            }
            const value = v.parse(
                v.object({
                    clientReference: v.string(),
                    idempotencyKey: v.string(),
                    displayName: v.string(),
                    locationHint: v.literal("apac"),
                }),
                JSON.parse(body),
            );
            let project = projects.get(value.idempotencyKey);
            if (project === undefined) {
                project = {
                    appId: "cloud-app",
                    tenantId: "tenant-test",
                    projectId: `project-${projects.size + 1}`,
                    clientReference: value.clientReference,
                    displayName: value.displayName,
                    lifecycle: "active",
                    createdAt: new Date(AUTH_TIME).toISOString(),
                    updatedAt: new Date(AUTH_TIME).toISOString(),
                    deletedAt: "",
                    suspendedAt: "",
                };
                projects.set(value.idempotencyKey, project);
            }
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify(project));
            return;
        }
        const botPath = request.url?.match(/^\/mobius\/api\/v1\/projects\/([^/]+)\/bots$/u);
        if (request.method === "POST" && botPath !== null && botPath !== undefined) {
            let body = "";
            for await (const chunk of request) {
                body += chunk;
            }
            const input = v.parse(
                v.object({ displayName: v.string(), description: v.string(), avatarRef: v.string() }),
                JSON.parse(body),
            );
            const bot = {
                ...input,
                botId: `bot-${bots.size + 1}`,
                projectId: botPath[1],
                lifecycle: "draft",
                lifecycleRevision: 1,
                profileRevision: 1,
                currentProfileRevisionId: `profile-${bots.size + 1}`,
                createdAt: AUTH_TIME.toISOString(),
                updatedAt: AUTH_TIME.toISOString(),
            };
            bots.set(bot.botId, bot);
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify(bot));
            return;
        }
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
        appCredential,
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

test("Given an anonymous user, When they provision a Platform Project and reload, Then Cloud retains their Project mapping and isolates it from other users without Clerk", async () => {
    const mobius = await mobiusService();
    const database = new InMemoryD1Database();
    databases.push(database);
    const bindings = {
        APP_ORIGIN,
        CLERK_JWT_KEY: issuer.publicKey,
        CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
        DATABASE: database,
        MOBIUS_APP_ID: "cloud-app",
        MOBIUS_APP_SECRET: mobius.appCredential,
        MOBIUS_BASE_URL: mobius.baseUrl,
        MOBIUS_PROJECT_LOCATION_HINT: "apac",
    };
    const createIdentity = async () => {
        const response = await worker.fetch(
            new Request("https://cloud.test/mobius-cloud/api/identity/anonymous-users", { method: "POST" }),
            bindings,
        );
        expect(response.status).toBe(201);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const alice = await createIdentity();
    const bob = await createIdentity();
    const endpoint = "https://cloud.test/mobius-cloud/api/management/project";
    try {
        const chatBotEndpoint = "https://cloud.test/mobius-cloud/api/chat/bots/bot-1";
        const wrongMethod = await worker.fetch(
            new Request(`${chatBotEndpoint}/access`, { headers: { authorization: `Bearer ${alice}` } }),
            bindings,
        );
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get("allow")).toBe("POST");
        const anotherUsersBot = await worker.fetch(
            new Request(`${chatBotEndpoint}/access`, {
                method: "POST",
                headers: { authorization: `Bearer ${bob}` },
            }),
            bindings,
        );
        expect(anotherUsersBot.status).toBe(404);
        for (const operation of ["workspace", "runtime-access"]) {
            const deniedInventory = await worker.fetch(
                new Request(`${chatBotEndpoint}/${operation}`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${bob}`, "content-type": "application/json" },
                    body: JSON.stringify({ runtimeId: "runtime-1" }),
                }),
                bindings,
            );
            expect(deniedInventory.status).toBe(404);
        }
        for (const body of ["{", JSON.stringify({ runtimeId: "runtime-1", agentRef: "opencode" })]) {
            const invalidSetup = await worker.fetch(
                new Request(`${chatBotEndpoint}/setup`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${alice}`, "content-type": "Application/JSON; charset=utf-8" },
                    body,
                }),
                bindings,
            );
            expect(invalidSetup.status).toBe(400);
            expect(await invalidSetup.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
        }
        const denied = await worker.fetch(
            new Request(endpoint, {
                method: "POST",
                headers: {
                    authorization: "Bearer invalid-token",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ displayName: "Bob" }),
            }),
            bindings,
        );
        expect(denied.status).toBe(401);
        for (const body of [
            "{",
            JSON.stringify({ displayName: "My Project", appId: "another-app" }),
            JSON.stringify({ displayName: "My Project", userId: "another-user" }),
        ]) {
            const invalid = await worker.fetch(
                new Request(endpoint, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${alice}`,
                        "content-type": "application/json",
                    },
                    body,
                }),
                bindings,
            );
            expect(invalid.status).toBe(400);
            expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const created = await worker.fetch(
                new Request(endpoint, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${alice}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ displayName: "My Project" }),
                }),
                bindings,
            );
            expect(created.status).toBe(200);
            expect(await created.json()).toEqual({
                project: { projectId: "project-1", displayName: "Personal workspace" },
            });
        }
        const reopened = await worker.fetch(
            new Request(endpoint, { headers: { authorization: `Bearer ${alice}` } }),
            bindings,
        );
        expect(await reopened.json()).toEqual({
            project: { projectId: "project-1", displayName: "Personal workspace" },
        });
        const other = await worker.fetch(
            new Request(endpoint, { headers: { authorization: `Bearer ${bob}` } }),
            bindings,
        );
        expect(await other.json()).toEqual({ project: { projectId: "project-2", displayName: "Personal workspace" } });
        const pairingEndpoint = "https://cloud.test/mobius-cloud/api/management/runtime-pairings";
        const pairingRequest = () =>
            new Request(pairingEndpoint, {
                method: "POST",
                headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "local-machine" }),
            });
        const pairingResponse = await worker.fetch(pairingRequest(), bindings);
        expect(pairingResponse.status).toBe(201);
        const pairing: unknown = await pairingResponse.json();
        expect(pairing).toMatchObject({
            pairingId: "pair-1",
            runtimeId: "runtime-1",
            projectId: "project-1",
            relayUrl: mobius.baseUrl,
            pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
        });
        expect(await (await worker.fetch(pairingRequest(), bindings)).json()).toEqual(pairing);
        const pending = await worker.fetch(
            new Request(`${pairingEndpoint}/pair-1`, { headers: { authorization: `Bearer ${alice}` } }),
            bindings,
        );
        expect(await pending.json()).toMatchObject({ status: "pending" });
        const forbidden = await worker.fetch(
            new Request(`${pairingEndpoint}/pair-1`, { headers: { authorization: `Bearer ${bob}` } }),
            bindings,
        );
        expect(forbidden.status).toBe(404);
        const bobProject = await worker.fetch(
            new Request(endpoint, {
                method: "POST",
                headers: { authorization: `Bearer ${bob}`, "content-type": "application/json" },
                body: JSON.stringify({ displayName: "Bob Project" }),
            }),
            bindings,
        );
        expect(bobProject.status).toBe(200);
        const isolated = await worker.fetch(
            new Request(`${pairingEndpoint}/pair-1`, { headers: { authorization: `Bearer ${bob}` } }),
            bindings,
        );
        expect(isolated.status).toBe(404);
    } finally {
        await mobius.close();
    }
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
