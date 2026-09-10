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
        baseConfiguration,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user_alice", sessionId: expect.stringMatching(/^sess_/) });
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
