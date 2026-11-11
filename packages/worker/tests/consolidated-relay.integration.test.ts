import { prepareTestMortyRelayBindings } from "@morty-build/relay-test-support/cloudflare";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { connectControlledAgentRuntime, createMortyFakeDaemon } from "../../../tests/support/fake-daemon/runtime.ts";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { memoryComputerCredentials } from "../../cli/tests/support/computer-credentials.ts";

let createBindings: Awaited<ReturnType<typeof prepareTestMortyRelayBindings>>;
beforeAll(async () => {
    createBindings = await prepareTestMortyRelayBindings();
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

test("Given one Morty Worker, When an owner pairs their Computer and opens a Session, Then Computer credentials, discovery and signed browser access work while retired backend endpoints are absent", async () => {
    await using bindings = await createBindings();
    await bindings.configure({ APP_ORIGIN: bindings.origin });
    const signal = AbortSignal.timeout(45_000);
    const request = (path: string, token?: string, body?: object) =>
        bindings.request(
            new Request(`${bindings.origin}/morty/api${path}`, {
                method: body === undefined ? "GET" : "POST",
                signal,
                headers: {
                    "content-type": "application/json",
                    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        );
    const created = await request("/identity/anonymous-users", undefined, {
        creationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    });
    expect(created.status).toBe(201);
    const owner = v.parse(v.object({ token: v.string(), computerId: v.string() }), await created.json());
    const paired = await request(`/computers/${owner.computerId}/management/pairing`, owner.token, {
        idempotencyKey: "single-worker",
    });
    expect(paired.status).toBe(201);
    const pairing = v.parse(v.object({ pairingCode: v.string(), relayUrl: v.string() }), await paired.json());
    expect(pairing.relayUrl).toBe(bindings.origin);
    const behavior = { harness: "codex", agentName: "Controlled Codex", reply: mortyReply };
    const harness = createMortyFakeDaemon(behavior);
    const redeemed = await request(`/v1/pairings/${owner.computerId}/redeem`, undefined, {
        pairingCode: pairing.pairingCode,
        machineName: "Single Worker",
        workspaceName: "Controlled workspace",
        agents: harness.catalog,
    });
    expect(redeemed.status).toBe(200);
    const claim = v.parse(v.object({ computerCredential: v.string() }), await redeemed.json());
    await using _runtime = await connectControlledAgentRuntime({
        behavior,
        signal,
        connection: {
            computerId: owner.computerId,
            origin: bindings.origin,
            credentials: memoryComputerCredentials(claim.computerCredential),
        },
    });
    const chat = `/chat/computers/${owner.computerId}`;
    const setup = await request(`${chat}/setup`, owner.token, { computerId: owner.computerId, harness: "codex" });
    expect(setup.status, await setup.clone().text()).toBe(202);
    const workspace = await request(`${chat}/workspace`, owner.token, {});
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toEqual({
        computer: expect.objectContaining({ computerId: owner.computerId, online: true }),
    });
    const computers = await request(`${chat}/setup/computers`, owner.token, {});
    expect(computers.status).toBe(200);
    expect(await computers.json()).toEqual({
        computers: [expect.objectContaining({ computerId: owner.computerId, online: true })],
    });
    const machine = await request(`/computers/${owner.computerId}/management/machine`, owner.token);
    expect(machine.status).toBe(200);
    expect(await machine.json()).toEqual({ computerPairing: "paired" });
    const opened = await request(`${chat}/access`, owner.token, {
        harness: "codex",
        conversationKey: "single-worker-session",
        workspaceRef: ".",
        configurations: [],
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const issued: unknown = await opened.json();
    const sdkAccess = new MortySessionAccess(issued);
    const access = v.parse(
        v.object({
            credential: v.string(),
            endpoint: v.string(),
            target: v.object({ harness: v.string(), sessionId: v.string() }),
        }),
        issued,
    );
    expect(sdkAccess.credential).toBe(access.credential);
    expect(sdkAccess.target).toEqual(access.target);
    expect(access.endpoint).toBe(bindings.origin);
    const session = `/v1/computers/${owner.computerId}/harnesses/${access.target.harness}/sessions/${access.target.sessionId}`;
    expect((await request(`${session}/live-event-subscription-target`, access.credential)).status).toBe(200);
    expect((await request(`${session}/live-event-subscription-target`)).status).toBe(401);
    for (const path of [
        "/dashboard/health",
        "/dashboard/v1/machine-accounts",
        `/v1/computers/${owner.computerId}/daemon/agents`,
    ]) {
        expect((await request(path)).status).toBe(404);
    }
});

import { MortySessionAccess } from "@morty-build/client";
