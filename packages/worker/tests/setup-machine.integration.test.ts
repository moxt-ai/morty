import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import { runSetup } from "../../setup/src/setup.ts";
import worker from "../src/application.ts";
import { projectObject } from "../src/gateway/project-object-routing.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

test("Given a user whose earlier release left an older Machine without a Runtime, When setup runs again and its handoff is opened, Then setup and the browser use the Machine running on this computer", {
    timeout: 60_000,
}, async () => {
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
    const runtime = new ControlledSetupRuntime({ agentId: "codex", agentName: "Codex", reply: mortyReply }, "Laptop");
    cleanup.defer(() => runtime.disconnect());
    let time = Date.parse("2026-10-30T00:00:00Z");
    const run = async () => {
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
        expect(code, JSON.stringify(events)).toBe(0);
        return v.parse(v.object({ status: v.literal("ready"), botId: v.string(), url: v.string() }), events.at(-1));
    };
    const configurationPath = join(state, "config.json");
    const configuration = async () =>
        v.parse(v.record(v.string(), v.unknown()), JSON.parse(await readFile(configurationPath, "utf8")));

    const first = await run();
    const saved = await configuration();
    const identity = v.parse(v.object({ user_id: v.string(), project_id: v.string() }), saved);
    await projectObject(fixture.environment(fixture.origin), identity.project_id).fetch(
        new Request("https://project.internal/legacy-machine", {
            method: "POST",
            body: JSON.stringify({ userId: identity.user_id, botId: "bot_legacy_without_runtime", createdAt: 0 }),
        }),
    );
    // Earlier releases saved the Machine they set up; their configuration files must still load.
    await writeFile(configurationPath, JSON.stringify({ ...saved, bot_id: first.botId }));

    const ready = await run();
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
});
