import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../worker/application.ts";
import { APP_ORIGIN, AUTH_TIME, IdentityProvider } from "./support/identity-provider.ts";

const issuer = new IdentityProvider();

class InMemoryD1Statement {
    readonly #query: string;
    readonly #queries: string[];

    constructor(query: string, queries: string[]) {
        this.#query = query;
        this.#queries = queries;
    }

    readonly bind = (..._values: readonly unknown[]) => this;
    readonly run = async () => {
        this.#queries.push(this.#query);
        return { meta: { changes: 1 } };
    };
}

class InMemoryD1Database {
    readonly #queries: string[] = [];
    readonly prepare = (query: string) => new InMemoryD1Statement(query, this.#queries);
    readonly batch = async (statements: readonly InMemoryD1Statement[]) =>
        await Promise.all(statements.map(async (statement) => await statement.run()));
}

const configuration = {
    CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
    CLERK_JWT_KEY: issuer.publicKey,
    APP_ORIGIN,
};

const slackConfiguration = {
    ...configuration,
    CLERK_ISSUER_URL: "https://clerk.test",
    AGENT_TRIGGER_RATE_LIMITER: {
        get: () => undefined,
        idFromName: () => undefined,
    },
    ASSETS: { fetch: () => Promise.resolve(new Response()) },
    ATTACHMENTS: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
    },
    AUTHENTICATION_BASE_URL: "https://identity.test",
    DATABASE: {
        batch: () => Promise.resolve([]),
        prepare: () => undefined,
    },
    EVENTS: { send: () => Promise.resolve() },
    MOBIUS_BASE_URL: "https://mobius.test",
    SLACK_MOBIUS_AUTH_TOKEN: "service-token",
    SLACK_OAUTH_STATE_SIGNING_KEY: "state-signing-key",
    SLACK_SERVER_BASE_URL: APP_ORIGIN,
    SLACK_TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
};

const mobiusConfiguration = {
    DIRECTORY_DATABASE: {
        batch: () => Promise.resolve([]),
        prepare: () => undefined,
    },
    RUNTIME_RELAY: {
        get: () => undefined,
        idFromName: () => undefined,
    },
    SESSION_RELAY: {
        get: () => undefined,
        idFromName: () => undefined,
    },
    SESSION_ACTIVE_SESSIONS_PER_PROJECT: "1000",
    SESSION_ACTIVE_SESSIONS_PER_TENANT: "10000",
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AUTH_TIME);
});

afterEach(() => vi.useRealTimers());

function accountRequest(token: string): Request {
    return new Request(`${APP_ORIGIN}/mobius-cloud/api/session`, {
        headers: { Authorization: `Bearer ${token}` },
    });
}

test("Given a visitor without a session, When they request their account, Then access is denied", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/session`), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
});

test("Given configured sign-in, When a visitor loads public configuration, Then only the publishable key is disclosed", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/config`), configuration);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        publishableKey: issuer.publishableKey,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("Given an active signed session, When the user requests their account, Then their verified identity is returned without being cached", async () => {
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team")),
        configuration,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        userId: "user_alice",
        sessionId: expect.stringMatching(/^sess_/),
        organizationId: "org_team",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("Given a user without an active organization, When they request their account, Then their identity does not imply workspace membership", async () => {
    const response = await worker.fetch(accountRequest(issuer.createSession("user_personal")), configuration);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        userId: "user_personal",
        organizationId: null,
    });
});

test("Given a token signed by an untrusted issuer, When it is used to request an account, Then access is denied", async () => {
    const otherIssuer = new IdentityProvider();
    const response = await worker.fetch(accountRequest(otherIssuer.createSession("user_forged")), configuration);
    expect(response.status).toBe(401);
});

test("Given a session issued for another origin, When it is used to request an account, Then access is denied", async () => {
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", "https://untrusted.example")),
        configuration,
    );
    expect(response.status).toBe(401);
});

test("Given an expired session, When the user requests their account, Then access is denied", async () => {
    const token = issuer.createSession("user_alice");
    vi.setSystemTime(new Date("2026-09-07T00:02:00.000Z"));
    const response = await worker.fetch(accountRequest(token), configuration);
    expect(response.status).toBe(401);
});

test("Given a session awaiting completion, When the user requests their account, Then access is denied", async () => {
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "pending")),
        configuration,
    );
    expect(response.status).toBe(401);
});

test("Given missing sign-in configuration, When a visitor opens sign-in, Then a safe availability error is returned", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/config`), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: {
            code: "AUTH_UNAVAILABLE",
            message: "Sign-in is temporarily unavailable.",
        },
    });
});

test("Given an unknown API route, When a visitor requests it, Then a JSON not-found response is returned", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/unknown`), configuration);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
});

test("Given the combined Cloud service, When Slack health is requested, Then the imported Slack application responds", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-slack/api/health`), slackConfiguration);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        service: "app-slack",
        status: "ok",
    });
});

test("Given the combined Cloud service, When Mobius health is requested, Then the imported Mobius application responds", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius/api/health`), mobiusConfiguration);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        service: "mobius-relay",
        status: "ok",
    });
});

test("Given Slack and Mobius share one Cloud Worker, When an organization member creates a pairing, Then Slack dispatches the Mobius request internally", async () => {
    const slackDatabase = new InMemoryD1Database();
    const directoryDatabase = new InMemoryD1Database();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/mobius/pairings`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "member")}`,
            },
        }),
        {
            ...slackConfiguration,
            ...mobiusConfiguration,
            CLERK_ISSUER_URL: "https://identity.clerk.accounts.dev",
            DATABASE: slackDatabase,
            DIRECTORY_DATABASE: directoryDatabase,
        },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
        channelId: expect.stringMatching(/^chn_/),
        pairingCode: expect.any(String),
        expiresAt: expect.any(String),
    });
});
