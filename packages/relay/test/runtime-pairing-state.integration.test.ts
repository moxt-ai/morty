import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { DurableObjectDatabaseAdapter, DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import {
    channelAccessGrant,
    channelHostCredential,
    runtimeDaemonCredential,
} from "@morty-build/relay-core/schema/project-do";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestMortyPlatformApp } from "../../platform-test-support/src/app.ts";
import { seedMortyService } from "../../platform-test-support/src/service-fixture.ts";
import { hashPairingCredential, hashSecret } from "../../relay-core/src/entity/pairing/pairing.ts";
import { RuntimeDirectoryStorage } from "../../relay-core/src/storage/runtime-directory-storage.ts";
import { computerDurableObjectMigrations } from "../src/generated/project-do-migrations.ts";
import { SqlitePlatformProjectStore } from "../src/storage/sqlite-platform-project-store.ts";
import { createPlatformGateways, PlatformAuthenticationConfiguration } from "../src/worker.ts";

const origin = `https://platform.test${MORTY_API_PREFIX}`;
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
    const worker = createTestMortyPlatformApp(new PlatformAuthenticationConfiguration(), createPlatformGateways);
    const { defaultCredential } = await seedMortyService(env.PLATFORM_DIRECTORY_DATABASE);
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
            const response = await worker.fetch(
                new Request(`${origin}${path}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
                {
                    ...env,
                    MORTY_COMPUTER_STORE: new SqlitePlatformProjectStore(
                        computerId,
                        new DurableObjectDatabaseAdapter(state.storage),
                    ),
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
        issueSession: () =>
            request(`/v1/computers/${computerId}/sessions/revoke-test/access-credentials`, "POST", {
                expiresInSeconds: 900,
            }),
        checkSession: (token: string) =>
            request(
                `/v1/computers/${computerId}/sessions/revoke-test/live-event-subscription-target`,
                "GET",
                undefined,
                token,
            ),
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
        readChannel: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.computerId}`, "GET", undefined, token),
        createGrant: async (pairing: Pairing, token: string) =>
            request(`/channels/${pairing.computerId}/access-grants`, "POST", undefined, token),
        redeemGrant: async (pairing: Pairing, grantId: string, grantSecret: string) =>
            request(`/channels/${pairing.computerId}/access-grants/${grantId}/redeem`, "POST", { grantSecret }),
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
    await app.sql(`CREATE TRIGGER reject_expiry_maintenance BEFORE INSERT ON runtime_pairing_audit_events
        WHEN NEW.action = 'runtime_pairing.expired'
        BEGIN SELECT RAISE(ABORT, 'Expiry maintenance is unavailable'); END`);
    vi.setSystemTime(new Date(first.expiresAt));
    expect(await responseJson(await app.status(first), 200)).toEqual({ status: "expired" });
    expect(await responseJson(await app.claim(first), 400)).toMatchObject({ error: { code: "invalid_pairing_code" } });
    expect(await app.pair("replacement")).toMatchObject({ computerId: app.computerId });
    expect((await app.create("reservation-0")).status).toBe(429);
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
    await app.sql(`CREATE TRIGGER reject_claim BEFORE INSERT ON runtime_pairing_audit_events
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
                storage.sql.exec("SELECT action FROM runtime_pairing_audit_events ORDER BY action").toArray(),
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
    await app.sql(`CREATE TRIGGER reject_revocation BEFORE INSERT ON runtime_pairing_audit_events
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

async function pairedChannelWithLegacyOwner() {
    const app = await project();
    const pairing = await app.pair("channel-access");
    const { runtimeCredential } = v.parse(
        v.object({ runtimeCredential: v.string() }),
        await responseJson(await app.claim(pairing), 200),
    );
    const hostToken = `${app.computerId}_${"H".repeat(43)}`;
    // Owner credentials issued before Runtime pairing remain valid channel callers.
    await app.storage(async (storage) => {
        new DurableObjectSqlDatabase(storage).orm
            .insert(channelHostCredential)
            .values({
                credentialId: "legacy-owner",
                computerId: pairing.computerId,
                tokenHash: await hashPairingCredential(hostToken),
                authority: "owner",
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
            })
            .run();
    });
    const grant = async () =>
        v.parse(
            v.strictObject({ expiresAt: v.string(), grantId: v.string(), grantSecret: v.string() }),
            await responseJson(await app.createGrant(pairing, hostToken), 201),
        );
    return { app, pairing, hostToken, runtimeCredential, grant };
}

it("Given channel credentials and an unused access link, When their Runtime is revoked, Then access is denied without rewriting credential or grant facts", async () => {
    const { app, pairing, hostToken, runtimeCredential, grant } = await pairedChannelWithLegacyOwner();
    const used = await grant();
    const redemptions = await Promise.all([
        app.redeemGrant(pairing, used.grantId, used.grantSecret),
        app.redeemGrant(pairing, used.grantId, used.grantSecret),
    ]);
    redemptions.sort((left, right) => left.status - right.status);
    const [redeemed, repeated] = redemptions;
    if (redeemed === undefined || repeated === undefined) {
        throw new Error("Expected both redemption responses");
    }
    const linked = v.parse(
        v.strictObject({ hostToken: v.string(), computerId: v.string() }),
        await responseJson(redeemed, 200),
    );
    expect(await responseJson(repeated, 409)).toMatchObject({ error: { code: "access_grant_redeemed" } });
    expect((await app.readChannel(pairing, linked.hostToken)).status).toBe(200);
    const unused = await grant();
    const facts = () =>
        app.storage((storage) => {
            const database = new DurableObjectSqlDatabase(storage).orm;
            return {
                hosts: database
                    .select({ id: channelHostCredential.credentialId, revokedAt: channelHostCredential.revokedAt })
                    .from(channelHostCredential)
                    .orderBy(channelHostCredential.credentialId)
                    .all(),
                grants: database.select().from(channelAccessGrant).orderBy(channelAccessGrant.grantId).all(),
            };
        });
    const before = await facts();
    expect((await app.revoke(pairing)).status).toBe(204);
    expect(await facts()).toEqual(before);
    await app.restart();
    expect((await app.publish(pairing, runtimeCredential)).status).toBe(401);
    expect((await app.readChannel(pairing, hostToken)).status).toBe(401);
    expect((await app.readChannel(pairing, linked.hostToken)).status).toBe(401);
    expect(await responseJson(await app.redeemGrant(pairing, used.grantId, used.grantSecret), 409)).toMatchObject({
        error: { code: "access_grant_redeemed" },
    });
    expect(await responseJson(await app.redeemGrant(pairing, unused.grantId, unused.grantSecret), 401)).toEqual({
        error: { code: "runtime_revoked", message: "The Runtime has been revoked" },
    });
    // Refusing a revoked Runtime must neither consume the link nor issue a credential.
    expect(await facts()).toEqual(before);
});

it("Given expired links and stored links shortened by an older revoker, When they are redeemed, Then genuine expiry and Runtime revocation remain distinguishable", async () => {
    const { app, pairing, grant } = await pairedChannelWithLegacyOwner();
    const expired = await grant();
    vi.setSystemTime(new Date(expired.expiresAt));
    expect(await responseJson(await app.redeemGrant(pairing, expired.grantId, expired.grantSecret), 410)).toMatchObject(
        {
            error: { code: "access_grant_expired" },
        },
    );
    const legacy = await grant();
    expect((await app.revoke(pairing)).status).toBe(204);
    // Retain the pre-fix writer's persisted representation. Its lost deadline
    // cannot be reconstructed, but the authoritative revocation is still known.
    await app.storage((storage) => {
        new DurableObjectSqlDatabase(storage).orm
            .update(channelAccessGrant)
            .set({ expiresAt: Date.now() })
            .where(eq(channelAccessGrant.grantId, legacy.grantId))
            .run();
    });
    await app.restart();
    expect(await responseJson(await app.redeemGrant(pairing, legacy.grantId, legacy.grantSecret), 401)).toEqual({
        error: { code: "runtime_revoked", message: "The Runtime has been revoked" },
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
        applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
        return database.query("SELECT credential_id FROM channel_host_credentials ORDER BY credential_id");
    });
    expect(remaining).toEqual([{ credential_id: "ctlX_owner" }, { credential_id: "lnk_device" }]);
});

it("revoking a pairing invalidates its daemon credential after the same computer pairs again", async () => {
    const app = await project();
    const original = await app.pair("original");
    const credential = v.object({ computerId: v.string(), runtimeCredential: v.string() });
    const old = v.parse(credential, await responseJson(await app.claim(original), 200));
    expect(old.computerId).toBe(original.computerId);
    const { credential: sessionToken } = v.parse(
        v.object({ credential: v.string() }),
        await responseJson(await app.issueSession(), 201),
    );
    expect((await app.checkSession(sessionToken)).status).toBe(200);
    expect((await app.revoke(original)).status).toBe(204);
    const replacement = await app.pair("replacement");
    const current = v.parse(credential, await responseJson(await app.claim(replacement), 200));
    expect(current.computerId).toBe(replacement.computerId);
    expect(current.computerId).toBe(old.computerId);
    expect(current.runtimeCredential).not.toBe(old.runtimeCredential);
    expect((await app.checkSession(sessionToken)).status).toBe(401);
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
                .update(runtimeDaemonCredential)
                .set({ tokenHash: await hashSecret(`${retiredDomain}${old.runtimeCredential}`) })
                .where(eq(runtimeDaemonCredential.computerId, oldPairing.computerId))
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
