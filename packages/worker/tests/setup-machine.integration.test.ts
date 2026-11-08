import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResponseLossProxy } from "@morty-build/platform-test-support/response-loss-proxy";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import { runSetup } from "../../setup/src/setup.ts";
import worker from "../src/application.ts";
import { projectObject } from "../src/gateway/project-object-routing.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test.each(["current", "retired configuration", "ambiguous Machines"] as const)(
    "Given %s state, When setup runs again, Then it uses the current Machine or rejects unsupported state without rewriting it",
    {
        timeout: 60_000,
    },
    async (stateKind) => {
        await using cleanup = new AsyncDisposableStack();
        const fixture = await createIdentityFixture({
            listenOnLoopback: true,
            workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
        });
        cleanup.defer(() => fixture.close());
        const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-machine-")));
        cleanup.defer(() => rm(directory, { recursive: true, force: true }));
        const state = join(directory, "state");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const runtime = new ControlledSetupRuntime(
            { agentId: "codex", agentName: "Codex", reply: mortyReply },
            "Laptop",
        );
        cleanup.defer(() => runtime.disconnect());
        let time = Date.parse("2026-10-30T00:00:00Z");
        const run = async (expectedCode = 0) => {
            const events: Readonly<Record<string, unknown>>[] = [];
            const code = await runSetup(
                [
                    "setup",
                    "--base-url",
                    fixture.origin,
                    "--cwd",
                    workspace,
                    "--harness",
                    "codex",
                    "--session-id",
                    "native-machine",
                ],
                {
                    state,
                    runtime,
                    agentEnvironment: {},
                    signal: AbortSignal.timeout(40_000),
                    clock: {
                        now: () => new Date(time),
                        wait: async (milliseconds, signal) => {
                            signal.throwIfAborted();
                            time += milliseconds;
                        },
                    },
                    emit: (event) => events.push(event),
                },
            );
            expect(code, JSON.stringify(events)).toBe(expectedCode);
            if (expectedCode !== 0) {
                return events.at(-1);
            }
            return v.parse(v.object({ status: v.literal("ready"), botId: v.string(), url: v.string() }), events.at(-1));
        };
        const configurationPath = join(state, "config.json");
        const configuration = async () =>
            v.parse(v.record(v.string(), v.unknown()), JSON.parse(await readFile(configurationPath, "utf8")));

        const first = v.parse(v.object({ botId: v.string() }), await run());
        const saved = await configuration();
        const identity = v.parse(v.object({ user_id: v.string(), project_id: v.string() }), saved);
        if (stateKind === "ambiguous Machines") {
            await projectObject(fixture.environment(fixture.origin), identity.project_id).fetch(
                new Request("https://project.internal/additional-machine", {
                    method: "POST",
                    body: JSON.stringify({ userId: identity.user_id, botId: "bot_unexpected_machine", createdAt: 0 }),
                }),
            );
        }
        if (stateKind === "retired configuration") {
            await writeFile(configurationPath, JSON.stringify({ ...saved, bot_id: first.botId }));
        }
        if (stateKind !== "current") {
            const original = await readFile(configurationPath, "utf8");
            const outcome = await run(1);
            expect(outcome).toMatchObject({
                error: { code: stateKind === "retired configuration" ? "INVALID_CONFIGURATION" : "BOT_STATE_INVALID" },
            });
            expect(await readFile(configurationPath, "utf8")).toBe(original);
            return;
        }

        const ready = v.parse(v.object({ botId: v.string(), url: v.string() }), await run());
        const redeemed = await worker.fetch(
            new Request(`${fixture.origin}/morty/api/identity/transfers/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: new URLSearchParams(new URL(ready.url).hash.slice(1)).get("code") }),
            }),
            fixture.environment(fixture.origin),
        );

        expect(ready.botId).toBe(first.botId);
        expect(redeemed.status).toBe(200);
        expect(await redeemed.json()).toMatchObject({ userId: identity.user_id, botId: first.botId });
        expect(await configuration()).not.toHaveProperty("bot_id");
    },
);

test("Given the answer to setup's Runtime pairing is lost, When setup runs again, Then the Machine is bound to the Runtime of that same pairing", {
    timeout: 60_000,
}, async () => {
    await using cleanup = new AsyncDisposableStack();
    const fixture = await createIdentityFixture({
        listenOnLoopback: true,
        workerEntryPoint: fileURLToPath(new URL("./support/credential-storage-worker.ts", import.meta.url)),
    });
    cleanup.defer(() => fixture.close());
    const network = await createResponseLossProxy(fixture.origin);
    cleanup.defer(() => network.close());
    // Setup reaches the Worker through a network that can lose one answer; the Worker serves that origin.
    await fixture.changeAppOrigin(network.origin);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-pairing-")));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const state = join(directory, "state");
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const runtime = new ControlledSetupRuntime({ agentId: "codex", agentName: "Codex", reply: mortyReply }, "Laptop");
    cleanup.defer(() => runtime.disconnect());
    let time = Date.parse("2026-10-30T00:00:00Z");
    const run = async () =>
        await runSetup(
            [
                "setup",
                "--base-url",
                network.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "native-pairing",
            ],
            {
                state,
                runtime,
                agentEnvironment: {},
                signal: AbortSignal.timeout(40_000),
                clock: {
                    now: () => new Date(time),
                    wait: async (milliseconds, signal) => {
                        signal.throwIfAborted();
                        time += milliseconds;
                    },
                },
                emit: () => undefined,
            },
        );

    const lost = network.interruptNextRuntimePairing();
    expect(await run()).not.toBe(0);
    const pairing = await lost;
    expect(pairing.status).toBe(201);
    const pairedRuntime = v.parse(v.object({ runtimeId: v.string() }), JSON.parse(pairing.body)).runtimeId;

    expect(await run()).toBe(0);
    const saved = v.parse(
        v.object({ user_token: v.string(), project_id: v.string() }),
        JSON.parse(await readFile(join(state, "config.json"), "utf8")),
    );
    const machine = await fetch(`${fixture.origin}/morty/api/projects/${saved.project_id}/management/bot`, {
        headers: { authorization: `Bearer ${saved.user_token}` },
    });
    expect(await machine.json()).toMatchObject({ runtimeId: pairedRuntime });
});
