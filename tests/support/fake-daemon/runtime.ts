import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeConfig, MobiusRuntimeEngine, RuntimeLocalContext } from "@moxt-ai/mobius/runtime";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import {
    createFakeDaemon,
    type FakeAgentHarnessOptions,
    type HarnessReplyPlan,
} from "@moxt-ai/mobius-test-support/fake-daemon";
import * as v from "valibot";
import { createInteractionAgent } from "./interaction-agent.ts";
import { createSettingsAgent } from "./settings-agent.ts";
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

export interface ControlledAgentBehavior extends FakeAgentHarnessOptions {
    readonly files?: ReadonlyMap<string, { readonly content: string | Uint8Array; readonly mediaType: string }>;
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
        return { ...harness, agents: [createSettingsAgent()] };
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
    const harness = createMortyFakeDaemon(options.behavior, workspace);
    const relayUrl = new URL("/mobius/api/v1/runtimes/connect", options.connection.origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", options.connection.runtimeCredential);
    const config = createRuntimeConfig(
        {
            channelId: options.connection.channelId,
            defaultWorkspace: workspace,
            relayUrl,
        },
        harness.agents,
        new RuntimeLocalContext(directory, process.env),
    );
    const unexpectedFailure = Promise.withResolvers<never>();
    void unexpectedFailure.promise.catch(() => undefined);
    const start = async () => {
        const cancellation = new AbortController();
        const signal = AbortSignal.any([options.signal, cancellation.signal]);
        const ready = Promise.withResolvers<void>();
        const engine = new MobiusRuntimeEngine(config, {
            onConnectionStatus: (status) => {
                if (status === "online") {
                    ready.resolve();
                }
            },
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
        continueReply: harness.continueReply,
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
