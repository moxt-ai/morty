import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/application.ts";
import { APP_ORIGIN, AUTH_TIME, clerk as issuer } from "./support/clerk.ts";
import { platformPeer } from "./support/platform-peer.ts";

const platform = await platformPeer({ pairingLifetimeMilliseconds: 0 });
afterAll(platform.close);

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
    readonly raw = async () =>
        this.#database
            .prepare(this.#query)
            .all(...this.#values)
            .map((row) => Object.values(row));
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
        databases.push(this);
        this.#database.exec(readFileSync(new URL("../migrations/0003_platform_project.sql", import.meta.url), "utf8"));
        this.#database.exec(readFileSync(new URL("../migrations/0005_agent_pairing.sql", import.meta.url), "utf8"));
        this.#database.exec(
            readFileSync(new URL("../migrations/0007_identity_transfer_redemptions.sql", import.meta.url), "utf8"),
        );
        this.#database.exec(readFileSync(new URL("../migrations/0008_remote_access.sql", import.meta.url), "utf8"));
        this.#database.exec(readFileSync(new URL("../migrations/0010_chat_owned_bot.sql", import.meta.url), "utf8"));
        this.#database.exec(
            readFileSync(new URL("../migrations/0011_slack_chat_bot_binding.sql", import.meta.url), "utf8"),
        );
        this.#database.exec(
            readFileSync(new URL("../migrations/0012_remove_legacy_bot_migration.sql", import.meta.url), "utf8"),
        );
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
const databases: InMemoryD1Database[] = [];
const baseConfiguration = { CLERK_PUBLISHABLE_KEY: issuer.publishableKey, CLERK_JWT_KEY: issuer.publicKey, APP_ORIGIN };
function slackConfiguration(database = new InMemoryD1Database()) {
    const attachments = { get: () => Promise.resolve(null), put: () => Promise.resolve() };
    const base = {
        ...baseConfiguration,
        BOT_TRIGGER_RATE_LIMITER: { get: () => undefined, idFromName: () => undefined },
        ASSETS: { fetch: () => Promise.resolve(new Response()) },
        CHAT_ATTACHMENTS_APAC: attachments,
        CHAT_ATTACHMENTS_WNAM: attachments,
        AUTHENTICATION_BASE_URL: "https://identity.test",
        EVENTS: { send: () => Promise.resolve() },
        ...platform.bindings,
        SLACK_MOBIUS_AUTH_TOKEN: "service-token",
        SLACK_OAUTH_STATE_SIGNING_KEY: "state-signing-key",
        SLACK_SERVER_BASE_URL: APP_ORIGIN,
        SLACK_TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
    };
    const projects = {
        idFromName: (name: string) => name,
        get: (projectId: string) => ({
            fetch: (request: Request) =>
                worker.fetch(request, {
                    ...base,
                    ATTACHMENTS: attachments,
                    CHAT_PROJECT_ID: projectId,
                    DATABASE: database,
                }),
        }),
    };
    return { ...base, CHAT_PROJECTS: projects };
}
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
function accountRequest(token?: string, projectId?: string): Request {
    return new Request(
        `${APP_ORIGIN}/mobius-cloud/api${projectId === undefined ? "" : `/projects/${projectId}`}/session`,
        {
            headers: {
                ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
            },
        },
    );
}

async function createAnonymousUser(
    database: InMemoryD1Database,
): Promise<{ readonly token: string; readonly userId: string; readonly projectId: string }> {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, { method: "POST" }),
        slackConfiguration(database),
    );
    expect(response.status).toBe(201);
    return v.parse(v.object({ token: v.string(), userId: v.string(), projectId: v.string() }), await response.json());
}

test.each([
    ["AS", "CN", "apac-ne"],
    ["AS", "SG", "apac-se"],
    ["AS", "IN", "apac"],
    ["OC", "AU", "apac"],
    ["NA", "US", "wnam"],
    ["SA", "BR", "wnam"],
    ["EU", "DE", "wnam"],
    ["AF", "ZA", "wnam"],
    ["AN", "AQ", "wnam"],
    ["unknown", "US", "apac"],
])(
    "Given a visitor geolocated to %s/%s, When Chat provisions their workspace, Then Platform places it in %s and retains it when they travel",
    async (continent, country, region) => {
        // Cloudflare supplies cf metadata on incoming Requests; Node does not.
        class GeolocatedRequest extends Request {
            override readonly cf: { readonly continent: string; readonly country: string };
            constructor(request: Request, continent: string, country: string) {
                super(request);
                this.cf = { continent, country };
            }
        }
        const environment = slackConfiguration();
        const created = await worker.fetch(
            new GeolocatedRequest(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, {
                    method: "POST",
                    headers: { "cf-ipcountry": "US" },
                }),
                continent,
                country,
            ),
            environment,
        );
        expect(created.status).toBe(201);
        const identity = v.parse(v.object({ token: v.string(), projectId: v.string() }), await created.json());
        const projectRequest = () =>
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/project`, {
                headers: { authorization: `Bearer ${identity.token}` },
            });
        const response = await worker.fetch(projectRequest(), environment);
        expect(response.status).toBe(200);
        const initial = v.parse(v.object({ project: v.object({ projectId: v.string() }) }), await response.json());
        const projectCode = { apac: "ap", "apac-ne": "an", "apac-se": "as", wnam: "wn" }[region];
        expect(initial.project.projectId).toMatch(new RegExp(`^prj_${projectCode}_01_`));
        const revisited = await worker.fetch(
            new GeolocatedRequest(
                new Request(projectRequest(), {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${identity.token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ displayName: "Personal workspace" }),
                }),
                region === "wnam" ? "AS" : "NA",
                region === "wnam" ? "CN" : "US",
            ),
            environment,
        );
        expect(revisited.status).toBe(200);
        expect(await revisited.json()).toMatchObject(initial);
    },
);

test("Given Projects in separate regions, When users reopen and transfer their workspaces, Then Project objects retain their identities and reject another Project", async () => {
    const environment = slackConfiguration();
    class RegionalRequest extends Request {
        override readonly cf: { readonly continent: string };
        constructor(continent: string) {
            super(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, { method: "POST" });
            this.cf = { continent };
        }
    }
    const identitySchema = v.object({ userId: v.string(), projectId: v.string(), token: v.string() });
    const asian = await worker.fetch(new RegionalRequest("AS"), environment);
    const american = await worker.fetch(new RegionalRequest("NA"), environment);
    expect(asian.status).toBe(201);
    expect(american.status).toBe(201);
    const apac = v.parse(identitySchema, await asian.json());
    const wnam = v.parse(identitySchema, await american.json());
    const sameRegionResponse = await worker.fetch(new RegionalRequest("AS"), environment);
    expect(sameRegionResponse.status).toBe(201);
    const sameRegion = v.parse(identitySchema, await sameRegionResponse.json());
    expect((await worker.fetch(accountRequest(apac.token, sameRegion.projectId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(apac.token), environment)).status).toBe(401);
    for (const [identity, other] of [
        [apac, wnam],
        [wnam, apac],
    ]) {
        if (identity === undefined || other === undefined) {
            throw new Error("Missing identity fixture");
        }
        const session = await worker.fetch(accountRequest(identity.token, identity.projectId), environment);
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ userId: identity.userId });
        expect((await worker.fetch(accountRequest(identity.token, other.projectId), environment)).status).toBe(401);
        const transfer = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/transfers`, {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}` },
            }),
            environment,
        );
        expect(transfer.status).toBe(201);
        const { url } = v.parse(v.object({ url: v.string() }), await transfer.json());
        const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code");
        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                }),
                environment,
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ userId: identity.userId, projectId: identity.projectId });
        const reopened = await redeem();
        expect(reopened.status).toBe(200);
        expect(await reopened.json()).toMatchObject({ userId: identity.userId, projectId: identity.projectId });
    }
});

test("Given a first-time visitor, When an anonymous identity is created, Then their Bot is already available without manual setup", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const response = await worker.fetch(
        accountRequest(identity.token, identity.projectId),
        slackConfiguration(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: identity.userId,
    });
    const bots = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    expect(bots.status).toBe(200);
    expect(await bots.json()).toEqual({
        bots: [expect.objectContaining({ botId: expect.any(String), displayName: "My Bot" })],
    });
    const projectResponse = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/project`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    const { project } = v.parse(
        v.object({ project: v.object({ projectId: v.string() }) }),
        await projectResponse.json(),
    );
    expect(identity.projectId).toBe(project.projectId);
    expect(identity.token).toMatch(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u);
    expect(
        (
            await worker.fetch(
                accountRequest(identity.token, `prj_wn_01_${"z".repeat(24)}`),
                slackConfiguration(database),
            )
        ).status,
    ).toBe(401);
});

test("Given a user with a Bot on a Project-scoped Platform, When setup checks the Bot workspace, Then the draft Bot and available agents are returned", async () => {
    const database = new InMemoryD1Database();
    const environment = slackConfiguration(database);
    const identity = await createAnonymousUser(database);
    const listed = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        environment,
    );
    const { bots } = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await listed.json());
    const response = await worker.fetch(
        new Request(
            `${APP_ORIGIN}/mobius-cloud/api/chat/projects/${identity.projectId}/bots/${bots[0]?.botId}/workspace`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                body: "{}",
            },
        ),
        environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "draft", selected: null, agents: [] });
});

test("Given an anonymous user, When a transfer is redeemed six times, Then five devices receive that identity", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    expect(created.status).toBe(201);
    const transfer = v.parse(v.object({ url: v.string(), expiresAt: v.string() }), await created.json());
    expect(transfer.expiresAt).toBe(new Date(AUTH_TIME.getTime() + 24 * 60 * 60 * 1000).toISOString());
    const code = new URL(transfer.url).hash.slice("#code=".length);
    const redeem = () =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            slackConfiguration(database),
        );

    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    const tokens = [];
    for (let redemption = 0; redemption < 5; redemption++) {
        const response = await redeem();
        expect(response.status).toBe(200);
        const received = v.parse(
            v.object({ userId: v.string(), token: v.pipe(v.string(), v.startsWith("mobius_anon_v2_")) }),
            await response.json(),
        );
        expect(received.userId).toBe(identity.userId);
        tokens.push(received.token);
    }
    expect(new Set(tokens).size).toBe(5);

    const sixth = await redeem();
    expect(sixth.status).toBe(410);
    expect(await sixth.json()).toMatchObject({ error: { code: "TRANSFER_UNAVAILABLE" } });
});

test("Given remote browsers redeemed one access link, When one browser ends remote access, Then every remote credential and the link stop while the owner remains connected", async () => {
    const database = new InMemoryD1Database();
    const environment = slackConfiguration(database);
    const owner = await createAnonymousUser(database);
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${owner.projectId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    const transfer = v.parse(v.object({ url: v.string() }), await created.json());
    const code = new URL(transfer.url).hash.slice("#code=".length);
    const redeem = async () => {
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
            }),
            environment,
        );
        expect(response.status).toBe(200);
        return v.parse(v.object({ token: v.string() }), await response.json()).token;
    };
    const firstRemote = await redeem();
    const secondRemote = await redeem();

    const ended = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${owner.projectId}/identity/remote-access`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${firstRemote}` },
        }),
        environment,
    );

    expect(ended.status).toBe(204);
    expect((await worker.fetch(accountRequest(firstRemote, owner.projectId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(secondRemote, owner.projectId), environment)).status).toBe(401);
    expect((await worker.fetch(accountRequest(owner.token, owner.projectId), environment)).status).toBe(200);
    expect(
        (
            await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code }),
                }),
                environment,
            )
        ).status,
    ).toBe(410);
});

test.each(["anonymous", "clerk"])(
    "Given a %s web user with a Bot, When their pairing ticket is redeemed, Then the local agent receives the same user and Bot exactly once",
    async (kind) => {
        const database = new InMemoryD1Database();
        const anonymous = await createAnonymousUser(database);
        const token = kind === "anonymous" ? anonymous.token : issuer.createSession("user_pair", APP_ORIGIN);
        const environment = slackConfiguration(database);
        if (kind === "clerk") {
            const bound = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${anonymous.projectId}/identity/clerk-binding`, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ action: "bind", anonymousToken: anonymous.token }),
                }),
                environment,
            );
            expect(bound.status).toBe(200);
        }
        const session = await worker.fetch(accountRequest(token, anonymous.projectId), environment);
        const { userId } = v.parse(v.object({ userId: v.string() }), await session.json());
        const bots = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${anonymous.projectId}/management/bots`, {
                headers: { authorization: `Bearer ${token}` },
            }),
            environment,
        );
        const { bots: owned } = v.parse(
            v.object({ bots: v.array(v.object({ botId: v.string() })) }),
            await bots.json(),
        );
        const botId = owned[0]?.botId;
        expect(botId).toBeDefined();
        const created = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${anonymous.projectId}/identity/pairings`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ botId }),
            }),
            environment,
        );
        expect(created.status).toBe(201);
        const ticket = v.parse(v.object({ url: v.string(), expiresAt: v.string() }), await created.json());
        expect(ticket.expiresAt).toBe(new Date(AUTH_TIME.getTime() + 24 * 60 * 60 * 1000).toISOString());
        const url = new URL(ticket.url);
        expect(url.pathname).toBe("/pair.md");
        const redeem = () =>
            worker.fetch(
                new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/pairings/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ token: url.searchParams.get("token") }),
                }),
                environment,
            );
        vi.advanceTimersByTime(23 * 60 * 60 * 1000);
        const response = await redeem();
        expect(response.status).toBe(200);
        const identity = v.parse(
            v.object({
                token: v.string(),
                userId: v.string(),
                botId: v.string(),
                projectId: v.pipe(v.string(), v.minLength(1)),
            }),
            await response.json(),
        );
        expect(identity).toMatchObject({ userId, botId });
        const local = await worker.fetch(accountRequest(identity.token, identity.projectId), environment);
        expect(await local.json()).toMatchObject({ userId });
        expect((await redeem()).status).toBe(410);
    },
);

test("Given another user's Bot and an expired ticket, When pairing is requested, Then ownership and expiry prevent issuing a local credential", async () => {
    const database = new InMemoryD1Database();
    const owner = await createAnonymousUser(database);
    const other = await createAnonymousUser(database);
    const environment = slackConfiguration(database);
    const bots = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${owner.projectId}/management/bots`, {
            headers: { authorization: `Bearer ${owner.token}` },
        }),
        environment,
    );
    const { bots: owned } = v.parse(v.object({ bots: v.array(v.object({ botId: v.string() })) }), await bots.json());
    const issue = (token: string) =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/mobius-cloud/api/projects/${token === other.token ? other.projectId : owner.projectId}/identity/pairings`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ botId: owned[0]?.botId }),
                },
            ),
            environment,
        );
    expect((await issue(other.token)).status).toBe(404);
    expect((await issue("invalid")).status).toBe(401);
    const issued = await issue(owner.token);
    const { url } = v.parse(v.object({ url: v.string() }), await issued.json());
    const token = new URL(url).searchParams.get("token");
    const browserRedemption = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: token }),
        }),
        environment,
    );
    expect(browserRedemption.status).toBe(410);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const expired = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/pairings/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
        }),
        environment,
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: "PAIRING_TICKET_UNAVAILABLE" } });
});

test.each([
    { mode: "pair", conflict: false, invalidConfig: false },
    { mode: "setup", conflict: false, invalidConfig: false },
    { mode: "pair", conflict: true, invalidConfig: false },
    { mode: "pair", conflict: true, invalidConfig: true },
    { mode: "setup", conflict: true, invalidConfig: false },
])(
    "Given $mode instructions with local conflict=$conflict and invalid configuration=$invalidConfig, When the command connects and setup reconnects, Then the selected identity is saved and reused with fresh Runtime credentials",
    async ({ mode, conflict, invalidConfig }) => {
        const database = new InMemoryD1Database();
        const environment = slackConfiguration(database);
        const identity = await createAnonymousUser(database);
        const bots = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/management/bots`, {
                headers: { authorization: `Bearer ${identity.token}` },
            }),
            environment,
        );
        const { bots: owned } = v.parse(
            v.object({ bots: v.array(v.object({ botId: v.string() })) }),
            await bots.json(),
        );
        const issued = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/pairings`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${identity.token}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ botId: owned[0]?.botId }),
            }),
            environment,
        );
        const { url } = v.parse(v.object({ url: v.string() }), await issued.json());
        const ticket = new URL(url).searchParams.get("token") ?? "";
        // Real HTTP bridge to the production Worker; Platform uses the suite's stateful peer.
        const server = createServer(async (incoming, outgoing) => {
            try {
                let body = "";
                for await (const chunk of incoming) {
                    body += chunk;
                }
                const headers = new Headers();
                for (const [key, value] of Object.entries(incoming.headers)) {
                    if (typeof value === "string") {
                        headers.set(key, value);
                    }
                }
                const response = await worker.fetch(
                    new Request(new URL(incoming.url ?? "/", APP_ORIGIN), {
                        method: incoming.method ?? "GET",
                        headers,
                        ...(body === "" ? {} : { body }),
                        signal: AbortSignal.timeout(15000),
                    }),
                    environment,
                );
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(await response.text());
            } catch {
                outgoing.writeHead(500, { "content-type": "application/json" });
                outgoing.end(JSON.stringify({ error: { code: "TEST_BRIDGE_FAILED" } }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("HTTP bridge unavailable");
        }
        const base = `http://127.0.0.1:${address.port}`;
        const directory = await mkdtemp(join(tmpdir(), "mobius-setup-"));
        const previous = await createAnonymousUser(database);
        const previousConfig = {
            base_url: base,
            user_token: mode === "setup" ? identity.token : previous.token,
            user_id: mode === "setup" ? identity.userId : previous.userId,
            bot_id: mode === "setup" ? owned[0]?.botId : "previous-bot",
            project_id: mode === "setup" ? identity.projectId : previous.projectId,
            pairing_key: "previous-key",
            pairing: { pairingId: "previous-pairing" },
            runtime_process: { pid: 123, log_path: "previous.log" },
            agent_ref: "previous-agent",
            agent_config_revision: 99,
        };
        const previousContents = invalidConfig ? "invalid old configuration" : JSON.stringify(previousConfig);
        if (conflict) {
            await mkdir(join(directory, "mobius-chat"), { mode: 0o700 });
            await writeFile(join(directory, "mobius-chat", "config.json"), previousContents, {
                mode: 0o600,
            });
        }
        const run = (command = mode) =>
            new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    [
                        fileURLToPath(new URL("../../setup/src/cli.ts", import.meta.url)),
                        command,
                        "--base-url",
                        base,
                        "--harness",
                        "codex",
                        ...(command === "setup" ? ["--session-id", "test-session"] : []),
                        ...(command === "pair" ? [`--token=${ticket}`] : []),
                    ],
                    {
                        env: { ...process.env, DOCUMENT_DIR: directory },
                        signal: AbortSignal.timeout(15000),
                        stdio: ["pipe", "pipe", "pipe"],
                    },
                );
                let output = "";
                child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                    output += chunk;
                });
                child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
                    output += chunk;
                });
                child.once("error", reject);
                child.once("close", (code) => resolve({ code, output }));
                child.stdin.end();
            });
        try {
            const prepared = await run();
            expect(prepared.code, prepared.output).toBe(1);
            expect(prepared.output).toContain('"code":"RUNTIME_PAIRING_UNAVAILABLE"');
            expect(prepared.output).toContain('"status":"prepared"');
            const path = join(directory, "mobius-chat", "config.json");
            const config = v.parse(
                v.object({ user_token: v.string(), user_id: v.string(), bot_id: v.string(), pairing_key: v.string() }),
                JSON.parse(await readFile(path, "utf8")),
            );
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            expect(prepared.output).not.toContain(config.user_token);
            if (conflict) {
                const backups = (await readdir(join(directory, "mobius-chat"))).filter((name) =>
                    name.startsWith("config-backup-"),
                );
                expect(backups).toHaveLength(1);
                const backup = join(directory, "mobius-chat", backups[0] ?? "missing-backup");
                expect(await readFile(backup, "utf8")).toBe(previousContents);
                expect((await stat(backup)).mode & 0o777).toBe(0o600);
                expect(prepared.output).toContain('"status":"configuration_backed_up"');
                expect(prepared.output).not.toContain(previous.token);
                expect(config.user_id).toBe(identity.userId);
                if (mode === "setup") {
                    expect(config.user_token).toBe(identity.token);
                }
                expect(config.pairing_key).not.toBe(previousConfig.pairing_key);
                const replacement = JSON.parse(await readFile(path, "utf8"));
                expect(replacement.runtime_process).toBeUndefined();
                expect(replacement.agent_ref).toBeUndefined();
                expect(replacement.agent_config_revision).toBeUndefined();
            }
            if (mode === "pair") {
                expect(config).toMatchObject({ user_id: identity.userId, bot_id: owned[0]?.botId });
            }
            if (mode === "pair") {
                const consumed = await run();
                expect(consumed.code).toBe(1);
                expect(consumed.output).toContain('"code":"PAIRING_TICKET_UNAVAILABLE"');
                expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(config);
            }
            const resumed = await run("setup");
            expect(resumed.code, resumed.output).toBe(1);
            expect(resumed.output).toContain('"code":"RUNTIME_PAIRING_UNAVAILABLE"');
            const restarted = JSON.parse(await readFile(path, "utf8"));
            expect(restarted).toMatchObject({
                user_token: config.user_token,
                user_id: config.user_id,
                bot_id: config.bot_id,
            });
            expect(restarted.pairing_key).not.toBe(config.pairing_key);
            await expect(stat(join(directory, "mobius-chat", ".setup-lock"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(directory, { recursive: true, force: true });
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    },
);

test("Given an expired anonymous transfer, When a device redeems it, Then no credential is issued", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    const transfer = v.parse(v.object({ url: v.string() }), await created.json());
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: new URL(transfer.url).hash.slice("#code=".length) }),
        }),
        slackConfiguration(database),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "TRANSFER_UNAVAILABLE" } });
});

test("Given an unbound Clerk account, When the visitor binds their anonymous user, Then Clerk opens the same workspace", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice", APP_ORIGIN);
    const status = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/clerk-binding`, {
            headers: { authorization: `Bearer ${clerkToken}` },
        }),
        slackConfiguration(database),
    );
    expect(await status.json()).toEqual({ kind: "unbound" });

    const bound = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${identity.projectId}/identity/clerk-binding`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${clerkToken}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ action: "bind", anonymousToken: identity.token }),
        }),
        slackConfiguration(database),
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toEqual({ kind: "bound", userId: identity.userId });

    const session = await worker.fetch(accountRequest(clerkToken, identity.projectId), slackConfiguration(database));
    expect(await session.json()).toMatchObject({ authentication: { kind: "clerk" }, userId: identity.userId });
});

test("Given a Clerk account bound elsewhere, When the visitor overrides it, Then the local user becomes canonical and the old anonymous user remains usable", async () => {
    const database = new InMemoryD1Database();
    const first = await createAnonymousUser(database);
    const second = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice", APP_ORIGIN);
    const resolve = (anonymousToken: string, action: "bind" | "override") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/mobius-cloud/api/projects/${anonymousToken === first.token ? first.projectId : second.projectId}/identity/clerk-binding`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${clerkToken}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ action, anonymousToken }),
                },
            ),
            slackConfiguration(database),
        );
    expect((await resolve(first.token, "bind")).status).toBe(200);
    const conflict = await resolve(second.token, "bind");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "BINDING_CONFLICT" } });
    expect((await resolve(second.token, "override")).status).toBe(200);

    const clerkSession = await worker.fetch(accountRequest(clerkToken, second.projectId), slackConfiguration(database));
    expect(await clerkSession.json()).toMatchObject({ userId: second.userId });
    const oldAnonymousSession = await worker.fetch(
        accountRequest(first.token, first.projectId),
        slackConfiguration(database),
    );
    expect(await oldAnonymousSession.json()).toMatchObject({ userId: first.userId });
});

test("Given a Clerk account bound elsewhere, When the visitor discards the local user, Then its anonymous credentials stop working", async () => {
    const database = new InMemoryD1Database();
    const account = await createAnonymousUser(database);
    const local = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice", APP_ORIGIN);
    const request = (anonymousToken: string, action: "bind" | "discard-local") =>
        worker.fetch(
            new Request(
                `${APP_ORIGIN}/mobius-cloud/api/projects/${anonymousToken === account.token ? account.projectId : local.projectId}/identity/clerk-binding`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${clerkToken}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ action, anonymousToken }),
                },
            ),
            slackConfiguration(database),
        );
    expect((await request(account.token, "bind")).status).toBe(200);
    expect((await request(local.token, "discard-local")).status).toBe(200);

    const discarded = await worker.fetch(accountRequest(local.token, local.projectId), slackConfiguration(database));
    expect(discarded.status).toBe(401);
    const clerkSession = await worker.fetch(
        accountRequest(clerkToken, account.projectId),
        slackConfiguration(database),
    );
    expect(await clerkSession.json()).toMatchObject({ userId: account.userId });
});

test("Given a visitor without a Clerk session, When account data is requested, Then access is denied", async () => {
    const response = await worker.fetch(accountRequest(), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
});

test("Given configured Clerk sign-in, When public configuration is loaded, Then only the publishable key is disclosed", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/config`), baseConfiguration);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publishableKey: issuer.publishableKey });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("Given an active Clerk user, When account data is requested, Then only user and session identity are returned", async () => {
    const database = new InMemoryD1Database();
    const environment = slackConfiguration(database);
    const local = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice", APP_ORIGIN, "active", "org_ignored");
    const bound = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/projects/${local.projectId}/identity/clerk-binding`, {
            body: JSON.stringify({ action: "bind", anonymousToken: local.token }),
            headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
            method: "POST",
        }),
        environment,
    );
    expect(bound.status).toBe(200);
    const response = await worker.fetch(accountRequest(clerkToken, local.projectId), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "clerk" },
        userId: local.userId,
        sessionId: expect.stringMatching(/^sess_/),
    });
});

test("Given a token for another origin, When account data is requested, Then access is denied", async () => {
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", "https://untrusted.example")),
        baseConfiguration,
    );
    expect(response.status).toBe(401);
});

test("Given a pending Clerk session, When account data is requested, Then access is denied", async () => {
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "pending")),
        baseConfiguration,
    );
    expect(response.status).toBe(401);
});

test("Given Project storage, When an authenticated user lists Slack bots, Then the user ID scopes the empty result", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots?projectId=prj_ap_01_${"a".repeat(24)}`, {
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN)}`,
            },
        }),
        slackConfiguration(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [] });
});

test("Given a missing Project object namespace, When an authenticated user lists Slack bots, Then storage fails closed", async () => {
    const configuration = { ...slackConfiguration(), CHAT_PROJECTS: undefined };
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots?projectId=prj_ap_01_${"a".repeat(24)}`, {
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN)}`,
            },
        }),
        configuration,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "PROJECT_OBJECT_UNAVAILABLE" } });
});

test("Given the combined Worker, When Slack health is requested, Then Slack responds", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/health?projectId=prj_ap_01_${"a".repeat(24)}`),
        slackConfiguration(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "app-slack", status: "ok" });
});
