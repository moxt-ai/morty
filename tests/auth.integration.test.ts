import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as v from "valibot";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../packages/worker/src/application.ts";
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
    readonly #queries: string[] = [];
    readonly queries = (): readonly string[] => [...this.#queries];
    constructor() {
        this.#database.exec(
            readFileSync(new URL("../apps/slack/packages/worker/migrations/0001_initial.sql", import.meta.url), "utf8"),
        );
        databases.push(this);
    }
    readonly close = () => this.#database.close();
    readonly prepare = (query: string) => {
        this.#queries.push(query);
        return new InMemoryD1Statement(query, this.#database);
    };
    readonly batch = async (statements: readonly InMemoryD1Statement[]) => {
        this.#database.exec("BEGIN");
        try {
            const result = [];
            for (const statement of statements) {
                result.push(await statement.run());
            }
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };
}
const databases: InMemoryD1Database[] = [];
class InMemoryR2Bucket {
    readonly #reads: string[] = [];
    readonly reads = (): readonly string[] => [...this.#reads];
    readonly get = async (key: string) => {
        this.#reads.push(key);
        return null;
    };
    readonly put = async () => undefined;
}
const allocationInputSchema = v.object({
    environment: v.picklist(["staging", "production"]),
    name: v.string(),
    region: v.picklist(["apac", "wnam"]),
    userId: v.string(),
});
class InMemoryTenantAllocatorNamespace {
    readonly created: v.InferOutput<typeof allocationInputSchema>[] = [];
    readonly #placements = new Map<
        string,
        { readonly d1ShardId: string; readonly r2BucketId: string; readonly revision: number }
    >();
    readonly assign = (
        organizationId: string,
        placement: { readonly d1ShardId: string; readonly r2BucketId: string; readonly revision: number },
    ): void => {
        this.#placements.set(organizationId, placement);
    };
    readonly idFromName = (name: string) => name;
    readonly get = (_id: string) => ({
        fetch: async (request: Request) => {
            if (new URL(request.url).pathname === "/resolve") {
                const input = v.parse(v.object({ organizationId: v.string() }), await request.json());
                const placement = this.#placements.get(input.organizationId);
                return placement === undefined
                    ? Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })
                    : Response.json({ placement });
            }
            const input = v.parse(allocationInputSchema, await request.json());
            this.created.push(input);
            return Response.json(
                { canDelete: true, id: `org_created_${this.created.length}`, name: input.name },
                { status: 201 },
            );
        },
    });
}
const configuration = { CLERK_PUBLISHABLE_KEY: issuer.publishableKey, CLERK_JWT_KEY: issuer.publicKey, APP_ORIGIN };
const slackConfiguration = {
    ...configuration,
    CLERK_ISSUER_URL: "https://clerk.test",
    BOT_TRIGGER_RATE_LIMITER: { get: () => undefined, idFromName: () => undefined },
    ASSETS: { fetch: () => Promise.resolve(new Response()) },
    R2_BUCKET_APAC: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    AUTHENTICATION_BASE_URL: "https://identity.test",
    D1_SHARD_APAC_01: { batch: () => Promise.resolve([]), prepare: () => undefined },
    EVENTS: { send: () => Promise.resolve() },
    MOBIUS_BASE_URL: "https://mobius.test",
    SLACK_MOBIUS_AUTH_TOKEN: "service-token",
    SLACK_OAUTH_STATE_SIGNING_KEY: "state-signing-key",
    SLACK_SERVER_BASE_URL: APP_ORIGIN,
    SLACK_TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
};
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
function accountRequest(token: string): Request {
    return new Request(`${APP_ORIGIN}/mobius-cloud/api/session`, { headers: { Authorization: `Bearer ${token}` } });
}

test("Given a visitor without a session, When they request their account, Then access is denied", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/session`), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
});
test("Given configured sign-in, When a visitor loads public configuration, Then only the publishable key is disclosed", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/config`), configuration);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publishableKey: issuer.publishableKey });
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
        placement: null,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("Given a user without an active organization, When they request their account, Then their identity does not imply workspace membership", async () => {
    const response = await worker.fetch(accountRequest(issuer.createSession("user_personal")), configuration);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: "user_personal", organizationId: null, placement: null });
});
test("Given an active tenant with storage placement, When a business reads its session, Then the frozen logical D1 and R2 identifiers are returned from verified claims", async () => {
    const placement = { d1ShardId: "apac-02", r2BucketId: "apac", revision: 1 };
    const response = await worker.fetch(
        accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "admin", placement)),
        { ...configuration, DEPLOY_ENVIRONMENT: "production" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationId: "org_team", placement });
});
test("Given placement claims outside the configured inventory, When a business reads its session, Then the untrusted placement is rejected", async () => {
    const response = await worker.fetch(
        accountRequest(
            issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "admin", {
                d1ShardId: "unknown-01",
                r2BucketId: "apac",
                revision: 1,
            }),
        ),
        { ...configuration, DEPLOY_ENVIRONMENT: "production" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ placement: null });
});
test("Given a signed-in user, When they create a tenant, Then Cloud authorizes and sends it through the regional placement allocator", async () => {
    const allocator = new InMemoryTenantAllocatorNamespace();
    const request = new Request(`${APP_ORIGIN}/mobius-cloud/api/workspaces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${issuer.createSession("user_alice")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Research team" }),
    });
    Object.defineProperty(request, "cf", { value: Object.freeze({ continent: "OC" }) });
    const response = await worker.fetch(request, {
        ...configuration,
        DEPLOY_ENVIRONMENT: "staging",
        TENANT_PLACEMENT_ALLOCATOR: allocator,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ canDelete: true, id: "org_created_1", name: "Research team" });
    expect(allocator.created).toEqual([
        { environment: "staging", name: "Research team", region: "apac", userId: "user_alice" },
    ]);
});
test("Given a token signed by an untrusted issuer, When it is used to request an account, Then access is denied", async () => {
    const response = await worker.fetch(
        accountRequest(new IdentityProvider().createSession("user_forged")),
        configuration,
    );
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
    expect((await worker.fetch(accountRequest(token), configuration)).status).toBe(401);
});
test("Given a session awaiting completion, When the user requests their account, Then access is denied", async () => {
    expect(
        (await worker.fetch(accountRequest(issuer.createSession("user_alice", APP_ORIGIN, "pending")), configuration))
            .status,
    ).toBe(401);
});
test("Given missing sign-in configuration, When a visitor opens sign-in, Then a safe availability error is returned", async () => {
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/mobius-cloud/api/config`), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." },
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
    expect(await response.json()).toEqual({ service: "app-slack", status: "ok" });
});
test("Given a Cloud tenant without placement claims, When it requests Slack agents, Then storage access is rejected", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots`, {
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "admin")}`,
            },
        }),
        {
            ...slackConfiguration,
            CLERK_ISSUER_URL: "https://identity.clerk.accounts.dev",
            DEPLOY_ENVIRONMENT: "production",
        },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SLACK_STORAGE_UNAVAILABLE" } });
});
test("Given an invalid OAuth state and unavailable placement lookup, When the callback arrives, Then Slack rejects the token before selecting tenant storage", async () => {
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/oauth/callback?code=unused&state=invalid`),
        { ...slackConfiguration, DEPLOY_ENVIRONMENT: "production" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_SLACK_TOKEN" } });
});
test("Given a tenant placed on an APAC shard, When Slack loads its agents, Then the injected Slack repository uses only the assigned D1 shard", async () => {
    const otherDatabase = new InMemoryD1Database();
    const tenantDatabase = new InMemoryD1Database();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots`, {
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "admin", { d1ShardId: "apac-02", r2BucketId: "apac", revision: 1 })}`,
            },
        }),
        {
            ...slackConfiguration,
            CLERK_ISSUER_URL: "https://identity.clerk.accounts.dev",
            D1_SHARD_APAC_01: otherDatabase,
            DEPLOY_ENVIRONMENT: "production",
            D1_SHARD_APAC_02: tenantDatabase,
            R2_BUCKET_APAC: slackConfiguration.R2_BUCKET_APAC,
        },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [] });
    expect(tenantDatabase.queries()).toHaveLength(1);
    expect(otherDatabase.queries()).toHaveLength(0);
});
test("Given incomplete placement claims, When Slack handles an authenticated tenant request, Then storage routing fails closed", async () => {
    const database = new InMemoryD1Database();
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/slack/bots`, {
            headers: {
                Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", "org_team", "admin", { d1ShardId: "apac-02" })}`,
            },
        }),
        {
            ...slackConfiguration,
            CLERK_ISSUER_URL: "https://identity.clerk.accounts.dev",
            D1_SHARD_APAC_01: database,
            DEPLOY_ENVIRONMENT: "production",
        },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SLACK_STORAGE_UNAVAILABLE" } });
    expect(database.queries()).toHaveLength(0);
});
test("Given a tenant placed in APAC, When Slack reads an attachment, Then the injected attachment storage uses that tenant's regional R2 bucket", async () => {
    const otherBucket = new InMemoryR2Bucket();
    const tenantBucket = new InMemoryR2Bucket();
    const placements = new InMemoryTenantAllocatorNamespace();
    placements.assign("org_team", { d1ShardId: "apac-02", r2BucketId: "apac", revision: 1 });
    const response = await worker.fetch(
        new Request(`${APP_ORIGIN}/mobius-slack/api/files/org_team/T123/file-1/report.pdf`),
        {
            ...slackConfiguration,
            R2_BUCKET_WNAM: otherBucket,
            CLERK_ISSUER_URL: "https://identity.clerk.accounts.dev",
            DEPLOY_ENVIRONMENT: "production",
            D1_SHARD_APAC_02: new InMemoryD1Database(),
            R2_BUCKET_APAC: tenantBucket,
            TENANT_PLACEMENT_ALLOCATOR: placements,
        },
    );
    expect(response.status).toBe(404);
    expect(tenantBucket.reads()).toEqual(["org_team/T123/file-1/report.pdf"]);
    expect(otherBucket.reads()).toHaveLength(0);
});
