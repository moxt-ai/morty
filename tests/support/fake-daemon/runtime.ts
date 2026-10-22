/// <reference path="./previous-runtime.d.ts" />
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeConfig, MobiusRuntimeEngine, RuntimeLocalContext } from "@moxt-ai/mobius/runtime";
import * as previousRuntime from "@moxt-ai/mobius-previous/runtime";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import {
    createFakeDaemon,
    type FakeAgentHarnessOptions,
    type HarnessReplyPlan,
} from "@moxt-ai/mobius-test-support/fake-daemon";
import * as v from "valibot";
import { createInteractionAgent } from "./interaction-agent.ts";
import { createSettingsAgent, defineCurrentAgent } from "./settings-agent.ts";
import { createToolLifecycleAgent } from "./tool-lifecycle-agent.ts";

type TestServerApp = { readonly request: (request: Request) => Response | Promise<Response> };

const runtimePairingSchema = v.object({
    channelId: v.string(),
    pairingCode: v.string(),
    pairingId: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
});

const runtimeClaimSchema = v.object({
    channelId: v.string(),
    runtimeCredential: v.string(),
    runtimeId: v.string(),
});

export interface ControlledRuntimeConnection {
    readonly channelId: string;
    readonly origin: string;
    readonly runtimeCredential: string;
}

/**
 * The production daemon release that runs the controlled Agent. "previous" is the
 * pinned earlier npm release, for scenarios where users have not upgraded yet.
 */
type ControlledRuntimeRelease = "current" | "previous";

/** An Agent the controlled Runtime exposes, and the daemon release that runs it. */
export interface ControlledAgent {
    readonly id: string;
    readonly label: string;
    readonly runtime?: ControlledRuntimeRelease;
}

export interface ControlledAgentBehavior extends FakeAgentHarnessOptions {
    readonly files?: ReadonlyMap<string, { readonly content: string | Uint8Array; readonly mediaType: string }>;
    readonly runtime?: ControlledRuntimeRelease;
}

interface ControlledRuntimeEngine {
    readonly run: (signal: AbortSignal) => Promise<void>;
}

type RuntimeConnectionOptions = Parameters<typeof createRuntimeConfig>[0];

/** Creates the daemon configuration once, so Agent state survives restarts of its engine. */
function controlledRuntime(
    behavior: ControlledAgentBehavior,
    agents: ReturnType<typeof createMortyFakeDaemon>["agents"],
    connection: RuntimeConnectionOptions,
    directory: string,
    rediscoverAgents?: NonNullable<Parameters<typeof createRuntimeConfig>[5]>,
): { readonly start: (onConnectionStatus: (status: "online" | "reconnecting") => void) => ControlledRuntimeEngine } {
    const release = behavior.runtime ?? "current";
    switch (release) {
        case "current": {
            const config = createRuntimeConfig(
                connection,
                agents,
                new RuntimeLocalContext(directory, process.env),
                undefined,
                undefined,
                rediscoverAgents,
            );
            return { start: (onConnectionStatus) => new MobiusRuntimeEngine(config, { onConnectionStatus }) };
        }
        case "previous": {
            if (behavior.agentId !== "settings-test") {
                throw new Error("The previous daemon release only runs the settings test Agent");
            }
            const config = previousRuntime.createRuntimeConfig(
                connection,
                [createSettingsAgent((...options) => new previousRuntime.InProcessAcpAgentDefinition(...options))],
                new previousRuntime.RuntimeLocalContext(directory, process.env),
            );
            return {
                start: (onConnectionStatus) => new previousRuntime.MobiusRuntimeEngine(config, { onConnectionStatus }),
            };
        }
        default:
            return release satisfies never;
    }
}

function workspaceReply(behavior: ControlledAgentBehavior, workspace: string): FakeAgentHarnessOptions["reply"] {
    const workspaceUrl = pathToFileURL(`${workspace}/`).href;
    return (prompt, turnNumber, mode): HarnessReplyPlan => {
        const plan = behavior.reply(prompt, turnNumber, mode);
        return {
            outcome: plan.outcome,
            output: plan.output.map((output) =>
                output.kind === "text"
                    ? { ...output, text: output.text.replaceAll("file:///workspace/", workspaceUrl) }
                    : output,
            ),
        };
    };
}

async function writeWorkspaceFiles(
    files: ControlledAgentBehavior["files"],
    workspace: string,
    signal: AbortSignal,
): Promise<void> {
    for (const [requestedPath, file] of files ?? []) {
        signal.throwIfAborted();
        if (!requestedPath.startsWith("/workspace/")) {
            throw new Error("Controlled Agent file paths must be inside /workspace");
        }
        const target = resolve(workspace, requestedPath.slice("/workspace/".length));
        const child = relative(workspace, target);
        if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
            throw new Error("Controlled Agent file path escaped /workspace");
        }
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, file.content, { signal });
    }
}

export function createMortyFakeDaemon(behavior: ControlledAgentBehavior, workspace?: string) {
    const harness = createFakeDaemon(
        workspace === undefined ? behavior : { ...behavior, reply: workspaceReply(behavior, workspace) },
    );
    if (behavior.agentId === "tool-lifecycle-test") {
        return { ...harness, agents: [createToolLifecycleAgent()] };
    }
    if (behavior.agentId === "interaction-test") {
        return { ...harness, agents: [createInteractionAgent()] };
    }
    if (behavior.agentId === "settings-test") {
        return { ...harness, agents: [createSettingsAgent(defineCurrentAgent)] };
    }
    return harness;
}

export async function connectControlledAgentRuntime(options: {
    readonly behavior: ControlledAgentBehavior;
    readonly connection: ControlledRuntimeConnection;
    readonly signal: AbortSignal;
}) {
    options.signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "morty-controlled-agent-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeWorkspaceFiles(options.behavior.files, workspace, options.signal);
    const relayUrl = new URL("/mobius/api/v1/runtimes/connect", options.connection.origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", options.connection.runtimeCredential);
    // The Agents can change across restarts, as when the user installs another Agent on the machine.
    // The injected set can also grow while the daemon runs; catalog discovery re-reads it, so
    // tests can install a harness after the Runtime came online.
    let agents: ReturnType<typeof createMortyFakeDaemon>["agents"] = [];
    const configure = (behavior: ControlledAgentBehavior) => {
        const harness = createMortyFakeDaemon(behavior, workspace);
        agents = harness.agents;
        const runtime = controlledRuntime(
            behavior,
            agents,
            { channelId: options.connection.channelId, defaultWorkspace: workspace, relayUrl },
            directory,
            (signal: AbortSignal) => {
                signal.throwIfAborted();
                return Promise.resolve([...agents]);
            },
        );
        return { harness, runtime };
    };
    let { harness, runtime } = configure(options.behavior);
    const unexpectedFailure = Promise.withResolvers<never>();
    void unexpectedFailure.promise.catch(() => undefined);
    const start = async () => {
        const cancellation = new AbortController();
        const signal = AbortSignal.any([options.signal, cancellation.signal]);
        const ready = Promise.withResolvers<void>();
        const engine = runtime.start((status) => {
            if (status === "online") {
                ready.resolve();
            }
        });
        const daemon = engine.run(signal);
        const failure = daemon.then<never>(() => {
            throw new Error("The production daemon stopped unexpectedly");
        });
        void failure.catch((cause: unknown) => {
            if (!signal.aborted) {
                unexpectedFailure.reject(cause);
            }
        });
        const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const abortReadiness = (): void => ready.reject(readinessSignal.reason);
        readinessSignal.addEventListener("abort", abortReadiness, { once: true });
        const stop = async (): Promise<void> => {
            cancellation.abort(new Error("Controlled Agent Runtime stopped"));
            await daemon.catch(() => undefined);
        };
        try {
            await Promise.race([ready.promise, failure]);
            return { stop };
        } catch (cause) {
            await stop();
            throw cause;
        } finally {
            readinessSignal.removeEventListener("abort", abortReadiness);
        }
    };
    const initial = await start().catch(async (cause: unknown) => {
        await rm(directory, { force: true, recursive: true });
        throw cause;
    });
    let state:
        | { readonly kind: "running"; readonly runtime: typeof initial }
        | { readonly kind: "disconnected" }
        | { readonly kind: "disposed" } = { kind: "running", runtime: initial };
    const disconnect = async (): Promise<void> => {
        if (state.kind !== "running") {
            return;
        }
        const runtime = state.runtime;
        state = { kind: "disconnected" };
        await runtime.stop();
    };
    return {
        continueReply: (...reply: Parameters<typeof harness.continueReply>) => harness.continueReply(...reply),
        /** Adds a controlled Agent to the daemon's injected set, as if it were installed. */
        installAgent: async (agent: { readonly id: string; readonly label: string }): Promise<void> => {
            const daemon = createMortyFakeDaemon({
                ...options.behavior,
                agentId: agent.id,
                agentName: agent.label,
            });
            const added = daemon.agents.filter(
                (entry) => entry.id === agent.id && !agents.some((existing) => existing.id === entry.id),
            );
            agents = [...agents, ...added];
        },
        writeFiles: async (files: NonNullable<ControlledAgentBehavior["files"]>): Promise<void> =>
            await writeWorkspaceFiles(files, workspace, options.signal),
        disconnect,
        reconnect: async (): Promise<void> => {
            if (state.kind === "disposed") {
                throw new Error("Cannot reconnect a disposed controlled Runtime");
            }
            if (state.kind === "disconnected") {
                state = { kind: "running", runtime: await start() };
            }
        },
        /** Restarts the Runtime offering other Agents, which it publishes to the Platform when it reconnects. */
        restartWithAgents: async (
            agents: Pick<ControlledAgentBehavior, "additionalAgents" | "agentId" | "agentName">,
        ): Promise<void> => {
            if (state.kind === "disposed") {
                throw new Error("Cannot restart a disposed controlled Runtime");
            }
            await disconnect();
            ({ harness, runtime } = configure({ ...options.behavior, ...agents }));
            state = { kind: "running", runtime: await start() };
        },
        failure: unexpectedFailure.promise,
        [Symbol.asyncDispose]: async (): Promise<void> => {
            if (state.kind === "disposed") {
                return;
            }
            await disconnect();
            state = { kind: "disposed" };
            await rm(directory, { force: true, recursive: true });
        },
    };
}

export async function createControlledAgentRuntime(options: {
    readonly behavior: ControlledAgentBehavior;
    readonly credential: string;
    readonly origin: string;
    readonly projectId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const pairing = v.parse(
        runtimePairingSchema,
        await (
            await options.server.request(
                new Request(`${options.origin}/mobius/api/v1/projects/${options.projectId}/runtime-pairings`, {
                    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                    headers: {
                        authorization: `Bearer ${options.credential}`,
                        "content-type": "application/json",
                    },
                    method: "POST",
                    signal: options.signal,
                }),
            )
        ).json(),
    );
    const harness = createMortyFakeDaemon(options.behavior);
    const claim = v.parse(
        runtimeClaimSchema,
        await (
            await options.server.request(
                new Request(`${options.origin}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
                    body: JSON.stringify({
                        agents: harness.catalog,
                        machineName: "Controlled Agent Runtime",
                        pairingCode: pairing.pairingCode,
                        workspaceName: "Controlled workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: options.signal,
                }),
            )
        ).json(),
    );
    const connected = await connectControlledAgentRuntime({
        behavior: options.behavior,
        connection: {
            channelId: claim.channelId,
            origin: options.origin,
            runtimeCredential: claim.runtimeCredential,
        },
        signal: options.signal,
    });
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(options.credential),
        endpoint: options.origin,
        projectId: pairing.projectId,
        transport: { fetch: async (request: Request) => await options.server.request(request) },
    });
    return {
        ...connected,
        client,
        runtimeId: claim.runtimeId,
    };
}
