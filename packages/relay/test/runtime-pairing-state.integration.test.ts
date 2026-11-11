import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { DurableObjectDatabaseAdapter } from "@morty-build/relay-core";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPairingCredential } from "../../relay-core/src/entity/pairing/pairing.ts";
import { RuntimeDirectoryStorage } from "../../relay-core/src/storage/runtime-directory-storage.ts";
import { createTestMortyRelayApp } from "../../relay-test-support/src/app.ts";
import { createRelayGateways, RelayAuthenticationConfiguration } from "../src/relay-worker.ts";
import { computerBackend, createOwner, ownerRequest } from "./owner-fixture.ts";

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
    const owner = await createOwner();
    const { computerId } = owner;
    const backend = computerBackend(computerId);
    const stub = env.COMPUTER_RELAY.getByName(computerId);
    const request = async (path: string, method = "GET", body?: object, token = owner.token) =>
        await worker.fetch(
            new Request(`${origin}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            env,
        );
    const management = (method: string, body?: object) =>
        ownerRequest(
            new Request(`${origin}/computers/${computerId}/management/pairing`, {
                method,
                headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
    const create = (idempotencyKey: string) => management("POST", { idempotencyKey });
    return {
        computerId,
        create,
        pair: async (key: string): Promise<Pairing> =>
            v.parse(pairingSchema, await responseJson(await create(key), 201)),
        status: async (_pairing: Pairing) => management("GET"),
        claim: async (pairing: Pairing, endpoint: "claim" | "redeem" = "redeem", machineName = "Runtime machine") =>
            request(endpoint === "claim" ? "/pairings/claim" : `/v1/pairings/${pairing.computerId}/redeem`, "POST", {
                pairingCode: pairing.pairingCode,
                machineName,
                workspaceName: "Runtime workspace",
                agents: [],
            }),
        revoke: async (_pairing: Pairing) => {
            try {
                await backend.revokeRuntime(AbortSignal.timeout(10000));
                return new Response(null, { status: 204 });
            } catch {
                return new Response(null, { status: 500 });
            }
        },
        list: async () => Response.json({ runtimes: await backend.runtimes(AbortSignal.timeout(10000)) }),
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
        const discarded = await app.claim(pairing, endpoint);
        expect(discarded.status).toBe(200);
        await discarded.body?.cancel();

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
