import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/application.ts";
import { createIdentityFixture } from "./support/identity-fixture.ts";

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly state: string;
            readonly agentEnvironment: Readonly<Record<string, string>>;
            readonly signal: AbortSignal;
            readonly runtime: ControlledSetupRuntime;
            readonly clock: {
                readonly now: () => Date;
                readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
            };
            readonly emit: (event: Readonly<Record<string, unknown>>) => void;
        },
    ) => Promise<number>;
}

const setupModule = v.custom<SetupModule>(
    (value) =>
        typeof value === "object" && value !== null && "runSetup" in value && typeof value.runSetup === "function",
);
const workerModule = v.object({
    default: v.custom<typeof worker>(
        (value) => typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function",
    ),
});
const identitySchema = v.object({
    token: v.string(),
    userId: v.string(),
    projectId: v.string(),
    bot: v.object({ botId: v.string() }),
});

// The optional matrix runs actual peers from an independently checked-out, pre-change revision.
// It never reconstructs the old peer by deleting the new check from current source.
// Baseline for PR #1069: 7a75d4b2a98f8ad05b0a73499d6ecee06c7940a7 (Mobius 91aa4b3e).
const retainedRoot = process.env["MORTY_COMPATIBILITY_BASE_ROOT"];
const scenarios = [
    { name: "current setup and current Worker", oldClient: false, oldWorker: false },
    ...(retainedRoot === undefined
        ? []
        : [
              { name: "retained setup and current Worker", oldClient: true, oldWorker: false },
              { name: "current setup and retained Worker", oldClient: false, oldWorker: true },
          ]),
];

// Stateful external admission port, explicitly replenished by the scenario; no real-time quota window.
class CreationBudget {
    remaining = 1;
    readonly limit = async () => ({ success: this.remaining-- > 0 });
}

for (const scenario of scenarios) {
    test(`Given ${scenario.name} and a lost creation response, When setup retries across temporary failures, Then it finishes with the original identity, Project and Machine`, {
        timeout: 60_000,
    }, async () => {
        const source = (path: string) => pathToFileURL(join(v.parse(v.string(), retainedRoot), path));
        const setup = v.parse(
            setupModule,
            await import(
                scenario.oldClient
                    ? source("packages/setup/src/setup.ts").href
                    : new URL("../../setup/src/setup.ts", import.meta.url).href
            ),
        );
        const serverWorker = scenario.oldWorker
            ? v.parse(workerModule, await import(source("packages/worker/src/application.ts").href)).default
            : worker;
        await using cleanup = new AsyncDisposableStack();
        const fixture = await createIdentityFixture(
            scenario.oldWorker
                ? {
                      workerEntryPoint: join(v.parse(v.string(), retainedRoot), "packages/worker/src/index.ts"),
                      wranglerConfiguration: source("wrangler.jsonc"),
                  }
                : {},
        );
        cleanup.defer(() => fixture.close());
        const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-identity-admission-")));
        cleanup.defer(() => rm(directory, { recursive: true, force: true }));
        const state = join(directory, "state");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const runtime = new ControlledSetupRuntime(
            { agentId: "codex", agentName: "Codex", reply: mortyReply },
            "Compatibility Runtime",
        );
        cleanup.defer(() => runtime.disconnect());
        const budget = new CreationBudget();
        let available = true;
        let loseResponse = true;
        let original: v.InferOutput<typeof identitySchema> | undefined;
        const creationKeys: string[] = [];
        const failures: unknown[] = [];
        let origin = "";
        // A real HTTP relay loses one successful response after the production Worker commits it.
        const server = createServer((incoming, outgoing) => {
            void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of incoming) {
                    chunks.push(Buffer.from(chunk));
                }
                const body = Buffer.concat(chunks);
                const headers = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (typeof value === "string") {
                        headers.set(name, value);
                    }
                }
                const request = new Request(new URL(incoming.url ?? "/", origin), {
                    method: incoming.method ?? "GET",
                    headers,
                    ...(body.length === 0 ? {} : { body }),
                    signal: AbortSignal.timeout(30_000),
                });
                const creation = new URL(request.url).pathname === "/morty/api/identity/anonymous-users";
                if (creation) {
                    creationKeys.push(
                        v.parse(v.object({ creationKey: v.string() }), JSON.parse(body.toString())).creationKey,
                    );
                }
                const response = await serverWorker.fetch(request, {
                    ...fixture.environment(origin),
                    ANONYMOUS_CREATION_LIMITER: available ? budget : undefined,
                });
                const bytes = await response.arrayBuffer();
                if (creation && response.status === 201 && loseResponse) {
                    original = v.parse(identitySchema, JSON.parse(Buffer.from(bytes).toString()));
                    loseResponse = false;
                    outgoing.destroy();
                    return;
                }
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(Buffer.from(bytes));
            })().catch((cause) => {
                failures.push(cause);
                outgoing.destroy();
            });
        });
        cleanup.defer(async () => {
            server.closeAllConnections();
            if (server.listening) {
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing compatibility HTTP address");
        }
        origin = `http://127.0.0.1:${address.port}`;
        await fixture.changeAppOrigin(origin);
        let time = Date.parse("2026-10-30T00:00:00Z");
        const run = async () => {
            const events: Readonly<Record<string, unknown>>[] = [];
            const code = await setup.runSetup(
                [
                    "setup",
                    "--base-url",
                    origin,
                    "--cwd",
                    workspace,
                    "--harness",
                    "codex",
                    "--session-id",
                    "native-compatibility",
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
            return { code, events };
        };
        const configuration = async () =>
            v.parse(v.record(v.string(), v.unknown()), JSON.parse(await readFile(join(state, "config.json"), "utf8")));
        {
            expect((await run()).code).toBe(1);
            const pending = await configuration();
            expect(pending["identity_creation_key"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            expect(pending).not.toHaveProperty("user_token");
            expect(original).toBeDefined();
            if (!scenario.oldWorker) {
                const limited = await run();
                expect(limited.code).toBe(1);
                expect(limited.events.at(-1)).toMatchObject({ error: { code: "IDENTITY_CREATION_RATE_LIMITED" } });
                expect(await configuration()).toEqual(pending);
                available = false;
                const unavailable = await run();
                expect(unavailable.code).toBe(1);
                expect(unavailable.events.at(-1)).toMatchObject({ error: { code: "IDENTITY_CREATION_UNAVAILABLE" } });
                expect(await configuration()).toEqual(pending);
            }
            available = true;
            budget.remaining = 1;
            const completed = await run();
            expect(completed.code, JSON.stringify(completed.events)).toBe(0);
            const identity = v.parse(identitySchema, original);
            expect(completed.events.at(-1)).toMatchObject({ status: "ready", workspace, botId: identity.bot.botId });
            expect(await configuration()).toMatchObject({
                user_token: identity.token,
                user_id: identity.userId,
                project_id: identity.projectId,
            });
            expect(await configuration()).not.toHaveProperty("identity_creation_key");
            expect(new Set(creationKeys)).toEqual(new Set([pending["identity_creation_key"]]));
            const session = await fetch(`${origin}/morty/api/projects/${identity.projectId}/session`, {
                headers: { authorization: `Bearer ${identity.token}` },
            });
            expect(session.status).toBe(200);
            expect(await session.json()).toMatchObject({ userId: identity.userId });
            expect(failures).toEqual([]);
        }
    });
}
