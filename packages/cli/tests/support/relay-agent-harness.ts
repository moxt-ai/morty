import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mortyApiPath } from "@morty-build/client/protocol";
import * as v from "valibot";
import { createOwnerApi } from "../../../../tests/support/owner-api.ts";
import { ComputerLocalContext } from "../../src/engine/computer/config.ts";
import { type RunComputerOptions, runComputer } from "../../src/engine/computer/run.ts";
import {
    defaultFakeAgentHarness,
    type FakeAgentHarnessDefinition,
    fakeAgentHarness,
    fakeAgentHarnessCapabilities,
} from "./agent-harness.ts";
import { memoryComputerCredentials } from "./computer-credentials.ts";
import { createControlledComputerConfig as createComputerConfig } from "./controlled-computer-config.ts";

type TestServerApp = { readonly request: (request: Request) => Response | Promise<Response> };

const computerPairingSchema = v.object({
    computerId: v.string(),
    pairingCode: v.string(),
});

function fakeAgentHarnessCatalog(definitions: readonly FakeAgentHarnessDefinition[]) {
    return definitions.map((agent) => ({
        agentPath: `/controlled-harness/${agent.harness}`,
        agentVersion: "controlled-harness",
        capabilities: fakeAgentHarnessCapabilities(agent),
        harness: agent.harness,
        label: agent.label,
    }));
}

/** Runs the production daemon with only its external Agent harness controlled. */
export async function createFakeAgentHarnessComputer(options: {
    readonly credential: string;
    readonly harnesses?: readonly FakeAgentHarnessDefinition[];
    readonly sessionIds?: ReadonlySet<string>;
    readonly origin: string;
    readonly relayOrigin?: string;
    readonly computerOptions?: RunComputerOptions;
    readonly computerId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    const directory = await mkdtemp(join(tmpdir(), "morty-agent-harness-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    let computer: Promise<void> | undefined;
    try {
        await Promise.all([mkdir(workspace), mkdir(harnessState)]);
        await Promise.all(
            [...(options.sessionIds ?? [])].map(async (sessionId) =>
                writeFile(
                    join(harnessState, `${encodeURIComponent(sessionId)}.json`),
                    JSON.stringify({
                        cwd: workspace,
                        fastMode: false,
                        history: [],
                        mode: "code",
                        model: "test-small",
                        reasoningEffort: "medium",
                        title: `Native ${sessionId}`,
                        turnCount: 1,
                    }),
                ),
            ),
        );
        const harnesses = options.harnesses ?? [defaultFakeAgentHarness];
        const pairing = v.parse(
            computerPairingSchema,
            await (
                await options.server.request(
                    new Request(`${options.origin}/morty/api/computers/${options.computerId}/management/pairing`, {
                        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                        headers: {
                            authorization: `Bearer ${options.credential}`,
                            "content-type": "application/json",
                        },
                        method: "POST",
                        signal,
                    }),
                )
            ).json(),
        );
        const claim = v.parse(
            v.object({ computerCredential: v.string() }),
            await (
                await options.server.request(
                    new Request(`${options.origin}/morty/api/v1/pairings/${pairing.computerId}/redeem`, {
                        body: JSON.stringify({
                            agents: fakeAgentHarnessCatalog(harnesses),
                            machineName: "Controlled Agent harness",
                            pairingCode: pairing.pairingCode,
                            workspaceName: "Controlled workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal,
                    }),
                )
            ).json(),
        );
        const relayUrl = new URL(mortyApiPath("/v1/computers/connect"), options.relayOrigin ?? options.origin);
        relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
        const localContext = new ComputerLocalContext(directory, process.env);
        const config = createComputerConfig(
            {
                credentials: memoryComputerCredentials(claim.computerCredential),
                computerId: pairing.computerId,
                defaultWorkspace: workspace,
                relayUrl,
            },
            harnesses.map((definition) => fakeAgentHarness(definition, harnessState)),
            localContext,
        );
        const online = Promise.withResolvers<void>();
        computer = runComputer(config, signal, undefined, {
            ...options.computerOptions,
            onConnectionStatus: (status) => {
                options.computerOptions?.onConnectionStatus?.(status);
                if (status === "online") {
                    online.resolve();
                }
            },
        });
        void computer.catch((error: unknown) => {
            if (!signal.aborted) {
                console.error("Controlled Agent harness daemon failed", error);
            }
        });
        const failure = computer.then<never>(() => {
            throw new Error("The production daemon stopped unexpectedly");
        });
        void failure.catch(() => undefined);
        const startup = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        startup.throwIfAborted();
        const aborted = Promise.withResolvers<never>();
        const abort = (): void => aborted.reject(startup.reason);
        startup.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([online.promise, failure, aborted.promise]);
        } finally {
            startup.removeEventListener("abort", abort);
        }
        const owner = createOwnerApi({
            origin: options.origin,
            computerId: pairing.computerId,
            credential: options.credential,
            request: async (request) => await options.server.request(request),
        });
        const selected = harnesses[0];
        if (selected !== undefined) {
            const setup = await options.server.request(
                new Request(`${options.origin}/morty/api/chat/computers/${pairing.computerId}/setup`, {
                    method: "POST",
                    signal,
                    headers: { authorization: `Bearer ${options.credential}`, "content-type": "application/json" },
                    body: JSON.stringify({ computerId: pairing.computerId, harness: selected.harness }),
                }),
            );
            if (setup.status !== 202) {
                throw new Error(`Computer setup failed (${setup.status})`);
            }
        }
        let disposed = false;
        return {
            api: owner.api,
            createSession: owner.createSession,
            sessionClient: owner.sessionClient,
            /** The controlled Agent's native history can be removed independently of Morty's receipts. */
            removeNativeSession: async (sessionId: string): Promise<void> => {
                await rm(join(harnessState, `${encodeURIComponent(sessionId)}.json`));
            },
            failure,
            computerId: pairing.computerId,
            [Symbol.asyncDispose]: async () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                owner.close();
                cancellation.abort(new Error("Controlled Agent harness Computer stopped"));
                await computer?.catch(() => undefined);
                await rm(directory, { recursive: true, force: true });
            },
        };
    } catch (cause) {
        cancellation.abort(cause);
        await computer?.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
        throw cause;
    }
}
