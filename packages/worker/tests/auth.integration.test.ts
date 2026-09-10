import { readFileSync } from "node:fs";
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
        databases.push(this);
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
    return {
        ...baseConfiguration,
        BOT_TRIGGER_RATE_LIMITER: { get: () => undefined, idFromName: () => undefined },
        ASSETS: { fetch: () => Promise.resolve(new Response()) },
        ATTACHMENTS: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
        AUTHENTICATION_BASE_URL: "https://identity.test",
        DATABASE: database,
        EVENTS: { send: () => Promise.resolve() },
        MOBIUS_BASE_URL: "https://mobius.test",
        MOBIUS_APP_ID: "cloud-app",
        MOBIUS_APP_SECRET: "cloud-secret",
        SLACK_MOBIUS_AUTH_TOKEN: "service-token",
        SLACK_OAUTH_STATE_SIGNING_KEY: "state-signing-key",
        SLACK_SERVER_BASE_URL: APP_ORIGIN,
        SLACK_TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
    };
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
function accountRequest(token?: string): Request {
    return new Request(`${APP_ORIGIN}/mobius-cloud/api/session`, {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
}

async function createAnonymousUser(
    database: InMemoryD1Database,
): Promise<{ readonly token: string; readonly userId: string }> {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/anonymous-users`, { method: "POST" }),
        slackConfiguration(database),
    );
    expect(response.status).toBe(201);
    return v.parse(v.object({ token: v.string(), userId: v.string() }), await response.json());
}

test("Given a first-time visitor, When an anonymous identity is created, Then its credential opens a persistent session", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const response = await worker.fetch(accountRequest(identity.token), slackConfiguration(database));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "anonymous" },
        userId: identity.userId,
    });
    const bots = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/management/bots`, {
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    expect(bots.status).toBe(200);
    expect(await bots.json()).toEqual({ bots: [] });
});

test("Given an anonymous user, When a transfer is redeemed twice, Then only the first device receives that identity", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    expect(created.status).toBe(201);
    const transfer = v.parse(v.object({ url: v.string(), expiresAt: v.string() }), await created.json());
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

    const first = await redeem();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
        userId: identity.userId,
        token: expect.stringMatching(/^mobius_anon_v1_/),
    });
    const second = await redeem();
    expect(second.status).toBe(410);
    expect(await second.json()).toMatchObject({ error: { code: "TRANSFER_UNAVAILABLE" } });
});

test("Given an expired anonymous transfer, When a device redeems it, Then no credential is issued", async () => {
    const database = new InMemoryD1Database();
    const identity = await createAnonymousUser(database);
    const created = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/transfers`, {
            method: "POST",
            headers: { authorization: `Bearer ${identity.token}` },
        }),
        slackConfiguration(database),
    );
    const transfer = v.parse(v.object({ url: v.string() }), await created.json());
    vi.advanceTimersByTime(15 * 60 * 1_000 + 1);

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
    const clerkToken = issuer.createSession("user_alice");
    const status = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/clerk-binding`, {
            headers: { authorization: `Bearer ${clerkToken}` },
        }),
        slackConfiguration(database),
    );
    expect(await status.json()).toEqual({ kind: "unbound" });

    const bound = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/clerk-binding`, {
            method: "POST",
            headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
            body: JSON.stringify({ action: "bind", anonymousToken: identity.token }),
        }),
        slackConfiguration(database),
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toEqual({ kind: "bound", userId: identity.userId });

    const session = await worker.fetch(accountRequest(clerkToken), slackConfiguration(database));
    expect(await session.json()).toMatchObject({ authentication: { kind: "clerk" }, userId: identity.userId });
});

test("Given a Clerk account bound elsewhere, When the visitor overrides it, Then the local user becomes canonical and the old anonymous user remains usable", async () => {
    const database = new InMemoryD1Database();
    const first = await createAnonymousUser(database);
    const second = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice");
    const resolve = (anonymousToken: string, action: "bind" | "override") =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/clerk-binding`, {
                method: "POST",
                headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
                body: JSON.stringify({ action, anonymousToken }),
            }),
            slackConfiguration(database),
        );
    expect((await resolve(first.token, "bind")).status).toBe(200);
    const conflict = await resolve(second.token, "bind");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "BINDING_CONFLICT" } });
    expect((await resolve(second.token, "override")).status).toBe(200);

    const clerkSession = await worker.fetch(accountRequest(clerkToken), slackConfiguration(database));
    expect(await clerkSession.json()).toMatchObject({ userId: second.userId });
    const oldAnonymousSession = await worker.fetch(accountRequest(first.token), slackConfiguration(database));
    expect(await oldAnonymousSession.json()).toMatchObject({ userId: first.userId });
});

test("Given a Clerk account bound elsewhere, When the visitor discards the local user, Then its anonymous credentials stop working", async () => {
    const database = new InMemoryD1Database();
    const account = await createAnonymousUser(database);
    const local = await createAnonymousUser(database);
    const clerkToken = issuer.createSession("user_alice");
    const request = (anonymousToken: string, action: "bind" | "discard-local") =>
        worker.fetch(
            new Request(`${APP_ORIGIN}/mobius-cloud/api/identity/clerk-binding`, {
                method: "POST",
                headers: { authorization: `Bearer ${clerkToken}`, "content-type": "application/json" },
                body: JSON.stringify({ action, anonymousToken }),
            }),
            slackConfiguration(database),
        );
    expect((await request(account.token, "bind")).status).toBe(200);
    expect((await request(local.token, "discard-local")).status).toBe(200);

    const discarded = await worker.fetch(accountRequest(local.token), slackConfiguration(database));
    expect(discarded.status).toBe(401);
    const clerkSession = await worker.fetch(accountRequest(clerkToken), slackConfiguration(database));
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
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "active", "org_ignored")),
        slackConfiguration(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        authentication: { kind: "clerk" },
        userId: "user_alice",
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

test("Given one Cloud D1, When an authenticated user lists Slack bots, Then the user ID scopes the empty result", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots`, {
            headers: { Authorization: `Bearer ${issuer.createSession("user_alice")}` },
        }),
        slackConfiguration(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [] });
});

test("Given no Cloud D1, When an authenticated user lists Slack bots, Then storage fails closed", async () => {
    const { DATABASE: _database, ...configuration } = slackConfiguration();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots`, {
            headers: { Authorization: `Bearer ${issuer.createSession("user_alice")}` },
        }),
        configuration,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SLACK_UNAVAILABLE" } });
});

test("Given the combined Worker, When Slack health is requested, Then Slack responds", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-slack/api/health`), slackConfiguration());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "app-slack", status: "ok" });
});
