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
import { createIdentityFixture } from "./support/identity-fixture.ts";

test.each(["current", "another service origin", "retired configuration"] as const)(
    "Given %s, When setup runs again, Then it continues the saved identity's Machine or refuses without rewriting the saved state",
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
        const run = async (expectedCode = 0, origin = fixture.origin) => {
            const events: Readonly<Record<string, unknown>>[] = [];
            const code = await runSetup(
                [
                    "setup",
                    "--base-url",
                    origin,
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
        const savedIdentity = v.object({
            base_url: v.string(),
            identity: v.object({ user_id: v.string(), user_token: v.string(), project_id: v.string() }),
        });

        const first = v.parse(v.object({ botId: v.string() }), await run());
        const saved = v.parse(savedIdentity, JSON.parse(await readFile(configurationPath, "utf8")));
        const identity = saved.identity;
        if (stateKind === "retired configuration") {
            // The representation setup wrote before its saved state was versioned.
            await writeFile(configurationPath, JSON.stringify({ base_url: saved.base_url, ...identity }));
        }
        if (stateKind !== "current") {
            const original = await readFile(configurationPath, "utf8");
            // The same service reached through another origin is still another service to the saved identity.
            const requested = new URL(fixture.origin);
            requested.hostname = "localhost";
            const outcome = await run(1, stateKind === "another service origin" ? requested.origin : fixture.origin);
            expect(outcome).toMatchObject({
                error:
                    stateKind === "another service origin"
                        ? {
                              code: "SAVED_IDENTITY_ORIGIN_MISMATCH",
                              savedIdentity: { savedBaseUrl: fixture.origin, requestedBaseUrl: requested.origin },
                          }
                        : { code: "INVALID_CONFIGURATION" },
            });
            expect(await readFile(configurationPath, "utf8")).toBe(original);
            if (stateKind !== "another service origin") {
                return;
            }
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
        expect(v.parse(savedIdentity, JSON.parse(await readFile(configurationPath, "utf8")))).toMatchObject({
            base_url: fixture.origin,
            identity,
        });
    },
);
