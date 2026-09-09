import { readdir, readFile } from "node:fs/promises";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelRuntime,
    CloudflareSessionTransport,
    R2ContentStore,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare/adapters";
import {
    ConfiguredPairingTenantResolver,
    ContentTarget,
    createBotApplication,
    createRelayDependencies,
    type TenantContext,
    type TenantShardingDirectory,
} from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createTestHarness, unstable_splitSqlQuery } from "wrangler";
import worker from "../worker/application.ts";
import { createMobiusStorage } from "../worker/di/mobius-storage.ts";
import { APP_ORIGIN, AUTH_TIME, IdentityProvider } from "./support/identity-provider.ts";

afterEach(() => vi.useRealTimers());

// Stateful placement authority at the external Clerk directory boundary. D1
// and R2 below use the actual local Cloudflare runtime.
class WorkspacePlacements {
    readonly assignments = new Map([
        ["org_apac", { d1ShardId: "apac-01", r2BucketId: "apac", revision: 1 }],
        ["org_wnam", { d1ShardId: "wnam-01", r2BucketId: "wnam", revision: 1 }],
    ]);
    readonly idFromName = (name: string) => name;
    readonly get = (_id: string) => ({
        fetch: async (request: Request) => {
            request.signal.throwIfAborted();
            const { organizationId } = v.parse(v.object({ organizationId: v.string() }), await request.json());
            const placement = this.assignments.get(organizationId);
            return placement === undefined
                ? Response.json({ error: "not found" }, { status: 404 })
                : Response.json({ placement });
        },
    });
}

const pairingSchema = v.object({
    channelId: v.string(),
    hostToken: v.string(),
    pairingCode: v.string(),
    pairingId: v.string(),
    pollToken: v.string(),
    projectId: v.string(),
    tenantId: v.string(),
    runtimeId: v.string(),
});

test("Given a Cloud workspace, When an anonymous browser creates a pairing, Then authentication is required", async () => {
    const response = await worker.fetch(
        new Request("https://cloud.test/mobius/api/pairings", { method: "POST" }),
        await harness.getWorker<Env>().getEnv(),
    );
    expect(response.status).toBe(401);
});

test.each([
    { organizationId: null, placement: null, status: 403 },
    { organizationId: "org_apac", placement: null, status: 503 },
    { organizationId: "org_apac", placement: { d1ShardId: "unknown", r2BucketId: "apac", revision: 1 }, status: 503 },
])(
    "Given no usable workspace placement ($organizationId, $status), When a signed-in browser creates a pairing, Then storage access is rejected",
    async ({ organizationId, placement, status }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(AUTH_TIME);
        const issuer = new IdentityProvider();
        const response = await worker.fetch(
            new Request(`${APP_ORIGIN}/mobius/api/pairings`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", organizationId, "admin", placement)}`,
                },
            }),
            {
                ...(await harness.getWorker<Env>().getEnv()),
                APP_ORIGIN,
                CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
                CLERK_JWT_KEY: issuer.publicKey,
                DEPLOY_ENVIRONMENT: "staging",
            },
        );
        expect(response.status).toBe(status);
    },
);

function createStorageHarness() {
    return createTestHarness({
        workers: [
            {
                config: {
                    name: "mobius-storage-test",
                    main: "tests/support/mobius-storage-worker.ts",
                    compatibility_date: "2026-09-07",
                    vars: { DEPLOY_ENVIRONMENT: "staging" },
                    d1_databases: [{ binding: "D1_SHARD_APAC_01" }, { binding: "D1_SHARD_WNAM_01" }],
                    r2_buckets: [
                        { binding: "R2_BUCKET_APAC", bucket_name: "test-apac" },
                        { binding: "R2_BUCKET_WNAM", bucket_name: "test-wnam" },
                    ],
                    durable_objects: {
                        bindings: [
                            { name: "RUNTIME_RELAY", class_name: "RuntimeRelay" },
                            { name: "SESSION_RELAY", class_name: "SessionRelay" },
                            { name: "BOT_CONNECTIONS", class_name: "BotConnectionActor" },
                            { name: "TENANT_PLACEMENT_ALLOCATOR", class_name: "TenantPlacementAllocator" },
                        ],
                    },
                    migrations: [
                        {
                            tag: "v1",
                            new_sqlite_classes: [
                                "RuntimeRelay",
                                "SessionRelay",
                                "TenantPlacementAllocator",
                                "BotConnectionActor",
                            ],
                        },
                    ],
                },
            },
        ],
    });
}

const harness = createStorageHarness();

class DeferredTenantPlacements implements TenantShardingDirectory {
    readonly #assignments = new Map<string, TenantContext>();
    readonly #waiting = new Set<() => void>();

    readonly assign = (tenant: TenantContext): void => {
        this.#assignments.set(tenant.tenantId, tenant);
        for (const ready of [...this.#waiting]) {
            ready();
        }
    };

    readonly resolve = (tenantId: string, signal: AbortSignal): Promise<TenantContext> => {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const release = () => {
                this.#waiting.delete(ready);
                signal.removeEventListener("abort", cancelled);
            };
            const cancelled = () => {
                release();
                reject(signal.reason);
            };
            const ready = () => {
                const tenant = this.#assignments.get(tenantId);
                if (tenant !== undefined) {
                    release();
                    resolve(tenant);
                }
            };
            this.#waiting.add(ready);
            signal.addEventListener("abort", cancelled, { once: true });
            if (signal.aborted) {
                cancelled();
            } else {
                ready();
            }
        });
    };
}

const contentOperations: readonly ("read" | "inspect" | "insert" | "delete")[] = [
    "read",
    "inspect",
    "insert",
    "delete",
];
test.each(contentOperations)(
    "Given stalled tenant placement, When an R2 %s reaches its deadline, Then the operation reports a content timeout",
    async (operation) => {
        const env = await harness.getWorker<Env>().getEnv();
        const placements = new DeferredTenantPlacements();
        const storage = new R2ContentStore({ resolve: () => env.R2_BUCKET_APAC }, placements);
        const target = new ContentTarget("stalled", "project", "session", operation);
        const controller = new AbortController();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(AUTH_TIME);
        const pending =
            operation === "insert"
                ? storage.insert(
                      target,
                      {
                          bytes: new Uint8Array(),
                          contentEncoding: "identity",
                          mediaType: "text/plain",
                          sha256: "0".repeat(64),
                      },
                      null,
                      controller.signal,
                  )
                : storage[operation](target, controller.signal);
        const settlement = pending.then(
            () => ({ kind: "success" }),
            (error: unknown) => ({ kind: "failure", error }),
        );
        try {
            await vi.advanceTimersByTimeAsync(15_000);
            const outcome = await Promise.race([settlement, Promise.resolve({ kind: "pending" })]);
            expect(outcome).toMatchObject({ kind: "failure", error: { code: "content_storage_timeout" } });
        } finally {
            controller.abort();
            await settlement;
            vi.useRealTimers();
        }
        placements.assign({ tenantId: "stalled", tenantSharding: { hasShard: false } });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(AUTH_TIME);
        expect(await storage.inspect(target, new AbortController().signal)).toEqual({ kind: "missing" });
    },
);

test("Given stalled tenant placement, When the caller cancels an R2 operation, Then the original cancellation is preserved", async () => {
    const env = await harness.getWorker<Env>().getEnv();
    const placements = new DeferredTenantPlacements();
    const storage = new R2ContentStore({ resolve: () => env.R2_BUCKET_APAC }, placements);
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(AUTH_TIME);
    const pending = storage.inspect(
        new ContentTarget("cancelled", "project", "session", "artifact"),
        controller.signal,
    );
    const reason = new DOMException("The caller cancelled content access", "AbortError");
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(15_000);
});
beforeAll(async () => {
    await harness.listen();
});
afterAll(async () => {
    await harness.close();
});

test("Given workspaces in two regions, When their members pair machines, create Bots, and store content, Then each workspace uses its assigned database and bucket", async () => {
    try {
        const platform = { env: await harness.getWorker<Env>().getEnv() };
        for (const database of [platform.env.D1_SHARD_APAC_01, platform.env.D1_SHARD_WNAM_01]) {
            const migrationDirectory = new URL("../mobius/packages/relay-cloudflare/migrations/d1/", import.meta.url);
            for (const migration of (await readdir(migrationDirectory))
                .filter((name) => name.endsWith(".sql"))
                .sort()) {
                const sql = await readFile(
                    new URL(`../mobius/packages/relay-cloudflare/migrations/d1/${migration}`, import.meta.url),
                    "utf8",
                );
                for (const statement of unstable_splitSqlQuery(sql)) {
                    await database.prepare(statement).run();
                }
            }
        }
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(AUTH_TIME);
        const issuer = new IdentityProvider();
        const placements = new WorkspacePlacements();
        const bindings = {
            ...platform.env,
            APP_ORIGIN,
            CLERK_PUBLISHABLE_KEY: issuer.publishableKey,
            CLERK_JWT_KEY: issuer.publicKey,
            DEPLOY_ENVIRONMENT: "staging",
            TENANT_PLACEMENT_ALLOCATOR: placements,
        };
        for (const [tenantId, placement] of [...placements.assignments]) {
            const response = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/pairings`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${issuer.createSession("user_alice", APP_ORIGIN, "active", tenantId, "admin", placement)}`,
                    },
                }),
                bindings,
            );
            expect(response.status).toBe(201);
            const pairing = v.parse(pairingSchema, await response.json());
            expect(pairing.tenantId).toBe(tenantId);
            const database = tenantId === "org_apac" ? platform.env.D1_SHARD_APAC_01 : platform.env.D1_SHARD_WNAM_01;
            const other = tenantId === "org_apac" ? platform.env.D1_SHARD_WNAM_01 : platform.env.D1_SHARD_APAC_01;
            expect(
                await database
                    .prepare("SELECT tenant_id FROM pairing_channels WHERE channel_id = ?")
                    .bind(pairing.channelId)
                    .first(),
            ).toEqual({ tenant_id: tenantId });
            expect(
                await other
                    .prepare("SELECT tenant_id FROM pairing_channels WHERE channel_id = ?")
                    .bind(pairing.channelId)
                    .first(),
            ).toBeNull();
            const claimed = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/pairings/claim`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        pairingCode: pairing.pairingCode,
                        machineName: "Machine",
                        workspaceName: "Project",
                        agents: [],
                        installableAgents: [{ id: "codex", label: "Codex", status: "agent_not_installed" }],
                    }),
                }),
                bindings,
            );
            expect(claimed.status, await claimed.clone().text()).toBe(200);
            const botContext = createRelayDependencies({
                ...createMobiusStorage(bindings),
                bots: { connections: new CloudflareBotConnectionRuntime(platform.env.BOT_CONNECTIONS) },
                config: { apiPrefix: "/mobius/api", quota: sessionQuotaFromEnvironment(bindings) },
                logger: console,
                gateways: {
                    channelGateway: new CloudflareChannelRuntime({
                        gateways: { runtimeRelay: platform.env.RUNTIME_RELAY },
                    }),
                    sessionTransport: new CloudflareSessionTransport(platform.env.SESSION_RELAY),
                    pairingTenantResolver: new ConfiguredPairingTenantResolver(tenantId),
                    nowEpochMilliseconds: () => Date.now(),
                },
            });
            if (botContext.services.bots === null) {
                throw new Error("Bot routes require an assembled Bot service");
            }
            const botApplication = createBotApplication();
            const botEnvironment = { services: { bots: botContext.services.bots } };
            const botResponse = await botApplication.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/v1/projects/${pairing.projectId}/bots`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${pairing.hostToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ displayName: tenantId, avatarRef: "", description: "Regional Bot" }),
                }),
                botEnvironment,
            );
            expect(botResponse.status, await botResponse.clone().text()).toBe(201);
            const bot = v.parse(v.object({ botId: v.string() }), await botResponse.json());
            const botRead = await botApplication.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/v1/bots/${bot.botId}`, {
                    headers: { Authorization: `Bearer ${pairing.hostToken}` },
                }),
                botEnvironment,
            );
            expect(botRead.status).toBe(200);
            expect(await botRead.json()).toMatchObject({ botId: bot.botId, displayName: tenantId });
            expect(
                await database.prepare("SELECT tenant_id FROM bots WHERE bot_id = ?").bind(bot.botId).first(),
            ).toEqual({ tenant_id: tenantId });
            expect(
                await other.prepare("SELECT tenant_id FROM bots WHERE bot_id = ?").bind(bot.botId).first(),
            ).toBeNull();
            placements.assignments.delete(tenantId);
            try {
                const denied = await botApplication.fetch(
                    new Request(`${APP_ORIGIN}/mobius/api/v1/bots/${bot.botId}`, {
                        headers: { Authorization: `Bearer ${"x".repeat(32)}` },
                    }),
                    botEnvironment,
                );
                expect(denied.status).toBe(403);
                expect(await denied.json()).toMatchObject({ error: { code: "owner_access_required" } });
                const unavailable = await botApplication.fetch(
                    new Request(`${APP_ORIGIN}/mobius/api/v1/bots/${bot.botId}`, {
                        headers: { Authorization: `Bearer ${pairing.hostToken}` },
                    }),
                    botEnvironment,
                );
                expect(unavailable.status).toBe(503);
            } finally {
                placements.assignments.set(tenantId, placement);
            }
            const daemon = v.parse(v.object({ daemonToken: v.string() }), await claimed.json());
            for (const [role, token] of [
                ["host", pairing.hostToken],
                ["daemon", daemon.daemonToken],
            ]) {
                const connected = await harness
                    .getWorker()
                    .fetch(`${APP_ORIGIN}/mobius/api/channels/${pairing.channelId}/${role}?token=${token}`, {
                        headers: { Upgrade: "websocket" },
                    });
                expect(connected.status).toBe(101);
                const socket = connected.webSocket;
                if (socket === null) {
                    throw new Error("The paired connection did not open");
                }
                socket.accept();
                socket.close(1000, "Scenario complete");
            }
            const channel = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/channels/${pairing.channelId}`, {
                    headers: { Authorization: `Bearer ${pairing.hostToken}` },
                }),
                bindings,
            );
            expect(channel.status).toBe(200);
            expect(await channel.json()).toMatchObject({ tenantId });
            const unauthorized = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/channels/${pairing.channelId}`, {
                    headers: { Authorization: `Bearer ${"x".repeat(32)}` },
                }),
                bindings,
            );
            expect(unauthorized.status).toBe(401);
            const sessionUrl = `${APP_ORIGIN}/mobius/api/projects/${pairing.projectId}/sessions`;
            const headers = { Authorization: `Bearer ${pairing.hostToken}`, "Content-Type": "application/json" };
            const created = await harness.getWorker().fetch(sessionUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session",
                    runtimeId: pairing.runtimeId,
                    agentId: "codex",
                    bindingId: "binding",
                    directoryId: "directory",
                    title: tenantId,
                    policy: {
                        level: "full",
                        retentionMilliseconds: 86_400_000,
                        hotEventLimit: 100,
                        contentLimitBytes: 1_000_000,
                        idempotencyRetentionMilliseconds: 86_400_000,
                    },
                }),
            });
            expect(created.status, await created.clone().text()).toBe(201);
            const listed = await harness.getWorker().fetch(sessionUrl, { headers });
            expect(listed.status).toBe(200);
            expect(await listed.json()).toMatchObject({ sessions: [{ sessionId: "session", tenantId }] });
            const bytes = new TextEncoder().encode(tenantId);
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const sha256 = Buffer.from(digest).toString("hex");
            const upload = await harness.getWorker().fetch(`${sessionUrl}/session/artifacts/uploads`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    byteLength: bytes.byteLength,
                    mediaType: "text/plain",
                    name: "note.txt",
                    sha256,
                }),
            });
            expect(upload.status, await upload.clone().text()).toBe(201);
            const lease = v.parse(v.object({ artifactId: v.string(), uploadToken: v.string() }), await upload.json());
            const artifactUrl = `${sessionUrl}/session/artifacts/${lease.artifactId}/content`;
            const uploaded = await harness.getWorker().fetch(artifactUrl, {
                method: "PUT",
                headers: { ...headers, "Content-Type": "text/plain", "x-mobius-upload-token": lease.uploadToken },
                body: bytes,
            });
            expect(uploaded.status, await uploaded.clone().text()).toBe(200);
            const descriptor = await harness.getWorker().fetch(artifactUrl.replace(/\/content$/u, ""), { headers });
            expect(descriptor.status, await descriptor.clone().text()).toBe(200);
            expect(await descriptor.json()).toMatchObject({ state: "available", sha256 });
            const bucket = tenantId === "org_apac" ? platform.env.R2_BUCKET_APAC : platform.env.R2_BUCKET_WNAM;
            const otherBucket = tenantId === "org_apac" ? platform.env.R2_BUCKET_WNAM : platform.env.R2_BUCKET_APAC;
            const prefix = `mobius/${tenantId}/${pairing.projectId}/session/`;
            const objects = (await bucket.list({ prefix })).objects;
            expect(objects).toHaveLength(1);
            const object = objects[0];
            if (object === undefined) {
                throw new Error("The uploaded artifact is missing");
            }
            const stored = await bucket.get(object.key);
            if (stored === null) {
                throw new Error("The uploaded artifact is missing");
            }
            expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
            expect((await otherBucket.list({ prefix })).objects).toHaveLength(0);
            const deleted = await harness.getWorker().fetch(`${sessionUrl}/session`, { method: "DELETE", headers });
            expect(deleted.status, await deleted.clone().text()).toBe(200);
            expect((await bucket.list({ prefix })).objects).toHaveLength(0);
            placements.assignments.delete(tenantId);
            const invalidWithoutPlacement = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/channels/${pairing.channelId}`, {
                    headers: { Authorization: `Bearer ${"x".repeat(32)}` },
                }),
                bindings,
            );
            expect(invalidWithoutPlacement.status).toBe(401);
            const unavailable = await worker.fetch(
                new Request(`${APP_ORIGIN}/mobius/api/channels/${pairing.channelId}`, { headers }),
                bindings,
            );
            expect(unavailable.status).toBe(503);
            placements.assignments.set(tenantId, placement);
        }
    } catch (error) {
        harness.debug();
        throw error;
    } finally {
        vi.useRealTimers();
    }
}, 30_000);
