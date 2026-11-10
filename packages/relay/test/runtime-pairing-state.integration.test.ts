import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import {
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    runtimeConnectionDurableObjectMigrations,
} from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { daemonCredential, runtimeRegistration } from "@morty-build/relay-core/schema/project-do";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPairingCredential, hashSecret } from "../../relay-core/src/entity/pairing/pairing.ts";
import { RuntimeDirectoryStorage } from "../../relay-core/src/storage/runtime-directory-storage.ts";
import { createTestMortyRelayApp } from "../../relay-test-support/src/app.ts";
import { seedMortyService } from "../../relay-test-support/src/service-fixture.ts";
import { computerDurableObjectMigrations } from "../src/generated/project-do-migrations.ts";
import { createRelayGateways, RelayAuthenticationConfiguration } from "../src/worker.ts";
import { composedComputer } from "./registered-runtime.ts";

const origin = `https://relay.test${MORTY_API_PREFIX}`;
const pairingSchema = v.object({
    expiresAt: v.string(),
    pairingCode: v.string(),
    pollToken: v.string(),
    computerId: v.string(),
});
type Pairing = Readonly<v.InferOutput<typeof pairingSchema>>;

async function responseJson(response: Response, status: number): Promise<unknown> {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

async function project(_name = "Runtime pairing") {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
    const { defaultCredential } = await seedMortyService(env.RELAY_DIRECTORY_DATABASE);
    const headers = {
        authorization: `Bearer ${defaultCredential.credential}`,
        "content-type": "application/json",
    };
    const dashboard = async (path: string, body?: object) =>
        await worker.fetch(
            new Request(`${origin}/dashboard/v1/${path}`, {
                headers,
                ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
            }),
            env,
        );
    const { computerId } = v.parse(
        v.object({ computerId: v.string() }),
        await responseJson(
            await dashboard("machine-accounts", {
                displayName: "Runtime pairing Project",
                idempotencyKey: "runtime-pairing-project",
                locationHint: "apac",
            }),
            201,
        ),
    );
    const stub = env.COMPUTER_RELAY.getByName(computerId);
    const request = async (path: string, method = "GET", body?: object, token = defaultCredential.credential) => {
        const result = await runInDurableObject(stub, async (_instance, state) => {
            const computer = composedComputer(computerId, state.storage);
            const response = await worker.fetch(
                new Request(`${origin}${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                {
                    ...env,
                    MORTY_COMPUTER_STORE: computer.store,
                    MORTY_COMPUTER_SESSION_ACCESS: computer.sessionAccess,
                    MORTY_COMPUTER_ID: computerId,
                },
            );
            // Consume the HTTP body within its DO request context so an unread
            // error response cannot keep a later eviction waiting for a stream.
            return { body: await response.text(), status: response.status, headers: [...response.headers] };
        });
        return new Response(result.body.length === 0 ? null : result.body, {
            status: result.status,
            headers: result.headers,
        });
    };
    const create = async (idempotencyKey: string) =>
        request(`/v1/computers/${computerId}/pairing`, "POST", { idempotencyKey });
    return {
        computerId,
        credentialId: defaultCredential.credentialId,
        create,
        pair: async (key: string): Promise<Pairing> =>
            v.parse(pairingSchema, await responseJson(await create(key), 201)),
        status: async (_pairing: Pairing) => request(`/v1/computers/${computerId}/pairing`),
        claim: async (pairing: Pairing, endpoint: "claim" | "redeem" = "redeem", machineName = "Runtime machine") =>
            request(endpoint === "claim" ? "/pairings/claim" : `/v1/pairings/${pairing.computerId}/redeem`, "POST", {
                pairingCode: pairing.pairingCode,
                machineName,
                workspaceName: "Runtime workspace",
                agents: [],
            }),
        revoke: async (_pairing: Pairing) => request(`/v1/computers/${computerId}/pairing`, "DELETE"),
        list: async () => request(`/v1/computers/${computerId}/runtimes`),
        publish: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.computerId}/catalog`, "PUT", { agents: [] }, token),
        storage: async <T>(operation: (storage: DurableObjectStorage) => Promise<T> | T): Promise<T> =>
            runInDurableObject(stub, async (_instance, state) => operation(state.storage)),
        restart: async () => evictDurableObject(stub),
        sql: async (sql: string) =>
            runInDurableObject(stub, async (_instance, state) => {
                state.storage.sql.exec(sql);
            }),
    };
}

it("Given a current pairing reservation, When an obsolete claim endpoint is called, Then it returns not found and leaves the reservation available for redemption", async () => {
    const app = await project();
    const pairing = await app.pair("retired-claim");
    expect(await responseJson(await app.claim(pairing, "claim"), 404)).toMatchObject({ error: { code: "not_found" } });
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
    expect((await app.claim(pairing)).status).toBe(200);
});

it("Given pending reservations at capacity, When their deadline passes without expiry maintenance, Then status reads and new reservations succeed", async () => {
    const app = await project();
    const first = await app.pair("reservation-0");
    expect(await responseJson(await app.create("over-capacity"), 429)).toMatchObject({
        error: { code: "runtime_quota_exceeded" },
    });
    // Expiry is the passage of time. Neither reading it nor reclaiming capacity
    // may require persisting a lifecycle transition, even when that write fails.
    await app.sql(`CREATE TRIGGER reject_expiry_maintenance BEFORE INSERT ON audit_events
        WHEN NEW.action = 'runtime_pairing.expired'
        BEGIN SELECT RAISE(ABORT, 'Expiry maintenance is unavailable'); END`);
    vi.setSystemTime(new Date(first.expiresAt));
    expect(await responseJson(await app.status(first), 200)).toEqual({ status: "expired" });
    expect(await responseJson(await app.claim(first), 400)).toMatchObject({ error: { code: "invalid_pairing_code" } });
    expect(await app.pair("replacement")).toMatchObject({ computerId: app.computerId });
    // A retry of the first request still names that request's generation, which a newer one replaced.
    expect(await app.pair("reservation-0")).toEqual(first);
});

it("Given simultaneous retries of one creation, When they commit, Then they share one reservation and occupy the single daemon slot", async () => {
    const app = await project();
    const [left, right] = await Promise.all([app.pair("same-request"), app.pair("same-request")]);
    expect(left).toEqual(right);
    expect((await app.create("no-place")).status).toBe(429);
});

it("Given a delayed claim, When newer requests have reused expired capacity, Then the claim cannot overbook the Project", async () => {
    const app = await project();
    const pairing = await app.pair("delayed-claim");
    const claimTime = Date.now();
    const codeHash = await hashPairingCredential(pairing.pairingCode);
    vi.setSystemTime(new Date(pairing.expiresAt));
    await app.pair("replacement");
    // Execute the original command against the real Project database after
    // newer transactions, as can happen when a database request is delayed.
    const claimed = await app.storage(async (storage) =>
        new RuntimeDirectoryStorage(app.computerId, new DurableObjectDatabaseAdapter(storage)).claim(
            {
                computerId: pairing.computerId,
                codeHash,
                daemonHash: await hashPairingCredential("delayed-runtime-credential"),
                now: claimTime,
                machineName: "Delayed machine",
                workspaceName: "Delayed workspace",
                agents: "[]",
                auditId: `rpa_${crypto.randomUUID()}`,
            },
            new AbortController().signal,
        ),
    );
    expect(claimed).toBe(false);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
});

it("Given a claim whose audit cannot commit, When the caller retries after recovery, Then the request is still pending and can be claimed once", async () => {
    const app = await project();
    const pairing = await app.pair("claim-rollback");
    await app.sql(`CREATE TRIGGER reject_claim BEFORE INSERT ON audit_events
        WHEN NEW.action = 'runtime_pairing.claimed'
        BEGIN SELECT RAISE(ABORT, 'Controlled claim failure'); END`);
    expect((await app.claim(pairing)).status).toBe(500);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
    await app.sql("DROP TRIGGER reject_claim");
    const claimed = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(204);
    expect(await responseJson(await app.claim(pairing), 200)).toMatchObject(claimed);
});

it.each(["redeem"] as const)(
    "Given a committed %s response is lost, When the caller retries after a relay restart, Then the original credential is recovered without changing the registration",
    async (endpoint) => {
        const app = await project();
        const pairing = await app.pair(`lost-${endpoint}`);
        // Discard the first result before the caller can save its credential.
        expect((await app.claim(pairing, endpoint)).status).toBe(200);
        await app.restart();
        vi.setSystemTime(new Date(Date.now() + 20_000));
        const response = await responseJson(await app.claim(pairing, endpoint, "Retry machine"), 200);
        // A retry returns the exact current redemption contract.
        const identity = { computerId: v.string() };
        const credential = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/));
        const runtimeCredential = v.parse(
            v.strictObject({ ...identity, runtimeCredential: credential }),
            response,
        ).runtimeCredential;
        expect(response).toMatchObject({
            computerId: pairing.computerId,
        });
        expect((await app.publish(pairing, runtimeCredential)).status).toBe(204);
        expect(await responseJson(await app.list(), 200)).toMatchObject({
            runtimes: [{ computerId: pairing.computerId, machineName: "Runtime machine" }],
        });
        expect(
            await app.storage((storage) =>
                storage.sql
                    .exec("SELECT action FROM audit_events WHERE category = 'pairing' ORDER BY action")
                    .toArray(),
            ),
        ).toEqual([{ action: "runtime_pairing.claimed" }, { action: "runtime_pairing.requested" }]);
        expect((await app.revoke(pairing)).status).toBe(204);
        expect(await responseJson(await app.claim(pairing, endpoint), 400)).toMatchObject({
            error: { code: "invalid_pairing_code" },
        });
        expect((await app.publish(pairing, runtimeCredential)).status).toBe(401);
    },
);

it("Given a revocation whose audit cannot commit, When it is retried, Then access remains until the complete revocation commits", async () => {
    const app = await project();
    const pairing = await app.pair("revoke-rollback");
    const claimed = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    await app.sql(`CREATE TRIGGER reject_revocation BEFORE INSERT ON audit_events
        WHEN NEW.action = 'runtime_pairing.revoked'
        BEGIN SELECT RAISE(ABORT, 'Controlled revocation failure'); END`);
    expect((await app.revoke(pairing)).status).toBe(500);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "paired" });
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(204);
    await app.sql("DROP TRIGGER reject_revocation");
    expect((await app.revoke(pairing)).status).toBe(204);
    expect((await app.publish(pairing, claimed.runtimeCredential)).status).toBe(401);
    expect(await responseJson(await app.status(pairing), 200)).toEqual({
        status: "revoked",
        revokedAt: new Date().toISOString(),
    });
});

it("Given one available Runtime place, When distinct requests compete, Then exactly one reserves it and retries keep the same identity", async () => {
    const app = await project();
    const responses = await Promise.all([app.create("competitor-a"), app.create("competitor-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    const winnerIndex = responses.findIndex((response) => response.status === 201);
    const winner = responses[winnerIndex];
    if (winner === undefined) {
        throw new Error("Expected one successful reservation");
    }
    const pairing = v.parse(pairingSchema, await responseJson(winner, 201));
    const key = winnerIndex === 0 ? "competitor-a" : "competitor-b";
    expect(await app.pair(key)).toEqual(pairing);
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "pending" });
});

it("Given a pending pairing, When claims arrive concurrently, Then they return the same credential and its Runtime survives the handshake deadline", async () => {
    const app = await project();
    const pairing = await app.pair("claim-once");
    const responses = await Promise.all([app.claim(pairing), app.claim(pairing)]);
    const results = await Promise.all(responses.map((response) => responseJson(response, 200)));
    expect(results[0]).toEqual(results[1]);
    const { runtimeCredential } = v.parse(v.object({ runtimeCredential: v.string() }), results[0]);
    vi.setSystemTime(new Date(Date.parse(pairing.expiresAt) + 1));
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    expect(await responseJson(await app.status(pairing), 200)).toMatchObject({ status: "paired", agents: [] });
    expect((await app.publish(pairing, runtimeCredential)).status).toBe(204);
    expect(await responseJson(await app.list(), 200)).toMatchObject({ runtimes: [{ computerId: pairing.computerId }] });
    expect((await app.revoke(pairing)).status).toBe(204);
    const revoked = await responseJson(await app.status(pairing), 200);
    expect(revoked).toEqual({ status: "revoked", revokedAt: new Date().toISOString() });
    vi.setSystemTime(new Date(Date.now() + 1_000));
    expect((await app.revoke(pairing)).status).toBe(204);
    expect(await responseJson(await app.status(pairing), 200)).toEqual(revoked);
    expect(await responseJson(await app.publish(pairing, runtimeCredential), 401)).toMatchObject({
        error: { code: "unauthorized" },
    });
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
    expect(await app.pair("claim-once")).toEqual(pairing);
});

it("Given an unclaimed Runtime identity, When it is revoked, Then its code cannot claim it and revocation remains visible after expiry", async () => {
    const app = await project();
    const pairing = await app.pair("cancel-before-claim");
    expect((await app.revoke(pairing)).status).toBe(204);
    const revoked = await responseJson(await app.status(pairing), 200);
    expect(revoked).toMatchObject({ status: "revoked" });
    expect(await responseJson(await app.claim(pairing), 400)).toMatchObject({
        error: { code: "invalid_pairing_code" },
    });
    vi.setSystemTime(new Date(pairing.expiresAt));
    expect(await responseJson(await app.status(pairing), 200)).toEqual(revoked);
    expect(await responseJson(await app.list(), 200)).toEqual({ runtimes: [] });
});

it("Given separate Projects, When they use the same pairing idempotency key, Then each receives its own stable Runtime identity", async () => {
    const first = await project();
    const second = await project("Another Runtime pairing App");
    const left = await first.pair("same-key");
    const right = await second.pair("same-key");
    expect(left.computerId).not.toBe(right.computerId);
    expect(await first.pair("same-key")).toEqual(left);
    expect(await second.pair("same-key")).toEqual(right);
});

it("Given stored Relay control host leases beside other Channel credentials, When the Project upgrades, Then only the leases are removed", async () => {
    const app = await project();
    const remaining = await app.storage(async (storage) => {
        await storage.deleteAll();
        const upgrade = computerDurableObjectMigrations.findIndex(
            (migration) => migration.name === "0008_remove_control_host_leases.sql",
        );
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations.slice(0, upgrade));
        const database = new DurableObjectSqlDatabase(storage);
        const credential = (credentialId: string, authority: "owner" | "linked", sourceGrantId: string | null) =>
            database.run(
                `INSERT INTO channel_host_credentials
                    (credential_id, channel_id, token_hash, authority, created_at, last_used_at, source_grant_id)
                 VALUES (?, 'channel-leases', ?, ?, 1, 1, ?)`,
                [credentialId, `hash-${credentialId}`, authority, sourceGrantId],
            );
        credential("ctl_lease", "linked", null);
        credential("ctlX_owner", "owner", null);
        credential("lnk_device", "linked", "grant-device");
        applyDurableObjectMigrations(storage, runtimeConnectionDurableObjectMigrations, "connections/");
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
        return database.query("SELECT credential_id FROM channel_host_credentials ORDER BY credential_id");
    });
    expect(remaining).toEqual([{ credential_id: "ctlX_owner" }, { credential_id: "lnk_device" }]);
});

it("Given a Runtime its owner revoked, When the computer is paired again, Then the old daemon credential is not accepted", async () => {
    const app = await project();
    const original = await app.pair("original");
    const credential = v.object({ computerId: v.string(), runtimeCredential: v.string() });
    const old = v.parse(credential, await responseJson(await app.claim(original), 200));
    expect(old.computerId).toBe(original.computerId);
    expect((await app.revoke(original)).status).toBe(204);
    const replacement = await app.pair("replacement");
    const current = v.parse(credential, await responseJson(await app.claim(replacement), 200));
    expect(current.computerId).toBe(replacement.computerId);
    expect(current.computerId).toBe(old.computerId);
    expect(current.runtimeCredential).not.toBe(old.runtimeCredential);
    expect((await app.publish(original, old.runtimeCredential)).status).toBe(401);
    expect((await app.publish(replacement, old.runtimeCredential)).status).toBe(401);
    expect((await app.publish(replacement, current.runtimeCredential)).status).toBe(204);
});

it.each(["", "morty-pairing-v1\0"])(
    "Given a retained Runtime credential from retired domain %j, When it reaches Morty authorization, Then it is rejected while project records remain and new pairing succeeds",
    async (retiredDomain) => {
        const app = await project();
        const oldPairing = await app.pair("pre-cutover-runtime");
        const old = v.parse(
            v.object({ runtimeCredential: v.string() }),
            await responseJson(await app.claim(oldPairing), 200),
        );
        await app.storage(async (storage) => {
            const database = new DurableObjectSqlDatabase(storage);
            database.orm
                .update(daemonCredential)
                .set({ tokenHash: await hashSecret(`${retiredDomain}${old.runtimeCredential}`) })
                .where(eq(daemonCredential.tokenHash, await hashPairingCredential(old.runtimeCredential)))
                .run();
        });
        expect((await app.publish(oldPairing, old.runtimeCredential)).status).toBe(401);
        expect(await responseJson(await app.status(oldPairing), 200)).toMatchObject({ status: "paired" });
        expect((await app.revoke(oldPairing)).status).toBe(204);
        const replacement = await app.pair("morty-generation-two");
        const current = v.parse(
            v.object({ runtimeCredential: v.string() }),
            await responseJson(await app.claim(replacement), 200),
        );
        expect((await app.publish(replacement, current.runtimeCredential)).status).toBe(204);
    },
);

it("migrates independent audit IDs of every category together", async () => {
    const app = await project();
    await app.storage(async (storage) => {
        await storage.deleteAll();
        const cutover = computerDurableObjectMigrations.findIndex(
            (entry) => entry.name === "0013_computer_storage.sql",
        );
        expect(cutover).toBeGreaterThan(0);
        applyDurableObjectMigrations(storage, runtimeConnectionDurableObjectMigrations, "connections/");
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations.slice(0, cutover));
        storage.sql.exec(`
            INSERT INTO runtimes (computer_id, created_at) VALUES ('machine', 10);
            INSERT INTO runtime_registrations (computer_id, claimed_at, machine_name, workspace_name, agents_json)
                VALUES ('machine', 11, 'laptop', 'work', '[]');
            INSERT INTO runtime_pairing_audit_events (audit_id,computer_id,actor_kind,actor_id,action,details_json,recorded_at)
                VALUES ('same','machine','runtime','machine','runtime_pairing.claimed','{}',11);
            INSERT INTO platform_audit_events (audit_id,project_id,app_id,actor_kind,actor_id,actor_ref,action,subject_id,outcome,details_json,recorded_at)
                VALUES ('same','machine','service','application','owner','owner','project.created','machine','succeeded','{}',10);
        `);
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
        expect(
            storage.sql.exec("SELECT category FROM audit_events WHERE audit_id='same' ORDER BY category").toArray(),
        ).toEqual([{ category: "computer_management" }, { category: "pairing" }]);
    });
});

it("keeps the newer epoch online when the previous daemon closes after reconnect", async () => {
    const app = await project();
    const paired = await app.pair("epoch-fencing");
    await app.claim(paired);
    await app.storage(async (storage) => {
        const { RuntimeConnectionStorage } = await import("../../relay-core/src/storage/runtime-connection-storage.ts");
        const { RuntimeConnectionService } = await import(
            "../../relay-core/src/service/channel/runtime-connection-service.ts"
        );
        const sql = new DurableObjectSqlDatabase(storage);
        const connections = new RuntimeConnectionService(new RuntimeConnectionStorage(sql));
        const registration = sql.orm
            .select({ generation: runtimeRegistration.generation })
            .from(runtimeRegistration)
            .get();
        if (registration === undefined) {
            throw new Error("Expected the claimed generation");
        }
        const first = connections.next(paired.computerId);
        connections.connected(first, registration.generation, 100);
        const second = connections.next(paired.computerId);
        expect(second.connectionEpoch).toBe(first.connectionEpoch + 1);
        connections.connected(second, registration.generation, 200);
        connections.disconnected(first, 300);
        expect(connections.isCurrent(first)).toBe(false);
        expect(connections.isCurrent(second)).toBe(true);
    });
});
