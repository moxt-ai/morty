import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonConfig, DaemonLocalContext, MobiusRuntimeEngine } from "@moxt-ai/mobius/runtime";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import { createFakeDaemon, type FakeAgentHarnessOptions } from "@moxt-ai/mobius-test-support/fake-daemon";
import * as v from "valibot";

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

export function createMortyFakeDaemon(behavior: FakeAgentHarnessOptions) {
    return createFakeDaemon(behavior);
}

export async function connectControlledAgentRuntime(options: {
    readonly behavior: FakeAgentHarnessOptions;
    readonly connection: ControlledRuntimeConnection;
    readonly signal: AbortSignal;
}) {
    options.signal.throwIfAborted();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    const directory = await mkdtemp(join(tmpdir(), "morty-controlled-agent-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const harness = createMortyFakeDaemon(options.behavior);
    const relayUrl = new URL("/mobius/api/v1/runtimes/connect", options.connection.origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", options.connection.runtimeCredential);
    const ready = Promise.withResolvers<void>();
    const config = createDaemonConfig(
        {
            channelId: options.connection.channelId,
            defaultWorkspace: workspace,
            relayUrl,
        },
        harness.agents,
        [],
        new DaemonLocalContext(directory, process.env),
    );
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
    void failure.catch(() => undefined);
    const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const abortReadiness = (): void => ready.reject(readinessSignal.reason);
    readinessSignal.addEventListener("abort", abortReadiness, { once: true });
    try {
        await Promise.race([ready.promise, failure]);
    } catch (cause) {
        cancellation.abort(cause);
        await daemon.catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
        throw cause;
    } finally {
        readinessSignal.removeEventListener("abort", abortReadiness);
    }
    let disposed = false;
    return {
        continueReply: harness.continueReply,
        failure,
        [Symbol.asyncDispose]: async (): Promise<void> => {
            if (disposed) {
                return;
            }
            disposed = true;
            cancellation.abort(new Error("Controlled Agent Runtime stopped"));
            await daemon.catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        },
    };
}

export async function createControlledAgentRuntime(options: {
    readonly behavior: FakeAgentHarnessOptions;
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
                        installableAgents: [],
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
