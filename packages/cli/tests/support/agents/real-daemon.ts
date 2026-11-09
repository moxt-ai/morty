import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionReadyEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionPrepareCommand,
    MORTY_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_WORKSPACE_BINDING_ID,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/platform-test-support/websocket";
import { type WebSocket, WebSocketServer } from "ws";
import { collectLocalDaemonLogs } from "../../../src/cli/handler/logs/logic/collect-local-logs.ts";
import { resolveMaxAcpProcesses } from "../../../src/daemon/config.ts";
import { sendLocalRequest } from "../../../src/daemon/control/local-client.ts";
import { lifecycleResponse } from "../../../src/daemon/control/protocol.ts";
import { openMortyInstallation } from "../../../src/daemon/pairing/pair-local-machine.ts";
import { harnessAdapters } from "../../../src/engine/acp/adapter/registry.ts";
import type { AdapterResolver } from "../../../src/engine/acp/native-history/preview-contract.ts";
import { discoverLocalAgentInventory } from "../../../src/engine/agent/discovery/discover-local-agents.ts";
import { RuntimeAgentDependencies } from "../../../src/engine/agent/runtime-agents.ts";
import type { LocalAgentSpecification } from "../../../src/engine/agent/specification/agent-specification.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../../src/engine/runtime/config.ts";
import {
    HEARTBEAT_ACK_TIMEOUT_MILLISECONDS,
    HEARTBEAT_INTERVAL_MILLISECONDS,
} from "../../../src/engine/runtime/relay/liveness.ts";
import { runRuntime } from "../../../src/engine/runtime/run.ts";
import { systemTimer, type Timer } from "../../../src/engine/util/timer.ts";
import { acpAdapters } from "../acp-adapters.ts";
import { memoryRuntimeCredentials } from "../runtime-credentials.ts";

export interface RealDaemonPeer {
    /** Runs a `morty` command against this daemon's installation, as the user's terminal would. */
    readonly cli: (args: readonly string[]) => Promise<void>;
    readonly restart: (mode?: "crash", restoreFiles?: () => Promise<void>) => Promise<void>;
    readonly stateDirectory: string;
    readonly send: (message: string | Uint8Array) => void;
    readonly sessionId: string;
    readonly workspace: string;
    readonly bindingId: string;
    readonly readDiagnostics: () => Promise<string>;
    readonly signal: AbortSignal;
    readonly nextEvent: () => Promise<string>;
    readonly nextFrame: () => Promise<string | Buffer>;
    readonly nextMessage: () => Promise<string>;
}

/** Controlled ACP harness registered explicitly, without changing real-Agent compatibility wiring. */
export const withControlledDaemon = (
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
    workspaceDirectory?: string,
    timer: Timer = systemTimer,
): Promise<void> =>
    withRealDaemon(specification, environment, scenario, launch, workspaceDirectory, timer, acpAdapters);

/**
 * Scenarios own time: the relay heartbeat's wall-clock deadlines never expire, so a slow host cannot close the
 * connection in the middle of a scenario. The connection liveness tests drive those deadlines with their own clock.
 */
function withoutRelayLivenessDeadlines(timer: Timer): Timer {
    return {
        schedule: (callback, milliseconds) =>
            milliseconds === HEARTBEAT_ACK_TIMEOUT_MILLISECONDS || milliseconds === HEARTBEAT_INTERVAL_MILLISECONDS
                ? { cancel: () => undefined }
                : timer.schedule(callback, milliseconds),
    };
}

/** Production daemon and discovery; the peer only sends and observes the public protocol. */
export async function withRealDaemon(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
    workspaceDirectory?: string,
    timer: Timer = systemTimer,
    adapters: AdapterResolver = harnessAdapters,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), `morty-real-${specification.id}-`));
    const workspace = workspaceDirectory ?? join(directory, "workspace");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const catalogs = new Map<string, string>();
    const relay = createServer((request, response) => {
        if (request.method === "PUT" && request.url?.endsWith("/catalog")) {
            const path = request.url;
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                catalogs.set(path, body);
                response.writeHead(204).end();
            });
        } else if (request.method === "GET" && request.url !== undefined && catalogs.has(request.url)) {
            response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(request.url));
        } else {
            response.writeHead(404).end();
        }
    });
    const server = new WebSocketServer({ server: relay });
    const runtimeTimer = withoutRelayLivenessDeadlines(timer);
    let runtime: Promise<void> | undefined;
    let execution = new AbortController();
    const cliEnvironment = { ...process.env, ...environment, MORTY_STATE_DIRECTORY: join(directory, "state") };
    const cli = async (args: readonly string[], deadline = signal): Promise<void> => {
        const child = spawn(
            process.execPath,
            [resolve(import.meta.dirname, "../../../src/cli/entrypoint.ts"), ...args],
            {
                env: cliEnvironment,
                signal: deadline,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        await new Promise<void>((resolve_, reject) => {
            child.once("error", (cause) => reject(new Error(`CLI ${args.join(" ")} failed: ${output}`, { cause })));
            child.once("close", (code) =>
                code === 0 ? resolve_() : reject(new Error(`CLI ${args.join(" ")} failed: ${output}`)),
            );
        });
    };
    let socket: WebSocket | undefined;
    const messages: Array<string | Buffer> = [];
    const recentFrames: string[] = [];
    let waiter: PromiseWithResolvers<string | Buffer> | undefined;
    const stopWaiting = (): void => waiter?.reject(signal.reason);
    signal.addEventListener("abort", stopWaiting, { once: true });
    try {
        await mkdir(workspace, { recursive: true });
        await listen(relay);
        let connected = Promise.withResolvers<void>();
        const abortConnection = (): void => connected.reject(signal.reason);
        signal.addEventListener("abort", abortConnection, { once: true });
        server.on("connection", (connection) => {
            socket = connection;
            connection.on("message", (value, isBinary) => {
                const message = isBinary ? Buffer.from(value as Buffer) : value.toString();
                if (typeof message === "string" && message !== RUNTIME_HEARTBEAT_MESSAGE) {
                    recentFrames.push(message);
                    if (recentFrames.length > 10) {
                        recentFrames.shift();
                    }
                }
                // Like the Relay's host, answer exactly the heartbeat text without the application.
                if (message === RUNTIME_HEARTBEAT_MESSAGE) {
                    connection.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
                    return;
                }

                if (waiter === undefined) {
                    messages.push(message);
                } else {
                    const pending = waiter;
                    waiter = undefined;
                    pending.resolve(message);
                }
            });
            connection.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
            connected.resolve();
        });
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/real-agent/daemon`);
        // Managed launches perform discovery in the production CLI; only an embedded
        // runtime needs a catalog prepared by the fixture.
        const config =
            launch === "embedded"
                ? await (async () => {
                      const inventory = await discoverLocalAgentInventory({
                          dataDirectory: directory,
                          defaultWorkspace: workspace,
                          environment: cliEnvironment,
                          signal,
                          specifications: [specification],
                      });
                      const agent = inventory.readyAgents().find((entry) => entry.id === specification.id);
                      if (agent === undefined) {
                          throw new Error(
                              `Real ${specification.label} unavailable: ${JSON.stringify(inventory.unavailable)}`,
                          );
                      }
                      return createRuntimeConfig(
                          {
                              credentials: memoryRuntimeCredentials("r".repeat(43)),
                              computerId: "real-agent",
                              defaultWorkspace: workspace,
                              relayUrl,
                          },
                          new RuntimeAgentDependencies([agent], adapters),
                          new RuntimeLocalContext(
                              directory,
                              { ...process.env, ...environment },
                              resolveMaxAcpProcesses(cliEnvironment),
                          ),
                      );
                  })()
                : null;
        if (launch === "managed") {
            const installation = await openMortyInstallation(signal, cliEnvironment);
            await installation.saveConnection(
                {
                    computerId: "real-agent",
                    defaultWorkspace: workspace,
                    relayOrigin: new URL(`http://127.0.0.1:${port(relay)}`),
                    runtimeCredential: "r".repeat(43),
                },
                signal,
            );
        }
        const start = async (): Promise<void> => {
            if (config === null) {
                await cli(["start"]);
            } else {
                execution = new AbortController();
                runtime = runRuntime(config, AbortSignal.any([signal, execution.signal]), runtimeTimer);
                void runtime.catch((error: unknown) => {
                    connected.reject(error);
                    waiter?.reject(error);
                });
            }
        };
        await start();
        try {
            await connected.promise;
        } finally {
            signal.removeEventListener("abort", abortConnection);
        }
        const nextFrame = async (): Promise<string | Buffer> => {
            signal.throwIfAborted();
            const message = messages.shift();
            if (message !== undefined) {
                return message;
            }
            waiter = Promise.withResolvers<string | Buffer>();
            return await waiter.promise;
        };
        const nextMessage = async (): Promise<string> => {
            const message = await nextFrame();
            if (typeof message !== "string") {
                throw new Error("Expected a text daemon message");
            }
            return message;
        };
        const pendingEvents: string[] = [];
        const sessionId = `real_${specification.id}_${randomUUID()}`;
        await scenario({
            restart: async (mode, restoreFiles) => {
                messages.length = 0;
                pendingEvents.length = 0;
                connected = Promise.withResolvers<void>();
                if (launch === "managed") {
                    if (mode === "crash") {
                        const control = await openMortyInstallation(signal, cliEnvironment);
                        const status = lifecycleResponse.parse(
                            await sendLocalRequest(control.stateDirectory, { kind: "status" }, signal),
                        );
                        if (status.kind !== "status") {
                            throw new Error("The managed daemon is unavailable for SIGKILL");
                        }
                        process.kill(status.daemon.pid, "SIGKILL");
                    } else {
                        await cli(["quit"]);
                    }
                } else {
                    execution.abort();
                    await runtime;
                }
                await restoreFiles?.();
                await start();
                await connected.promise;
            },
            stateDirectory: directory,
            bindingId: RUNTIME_WORKSPACE_BINDING_ID,
            cli: async (args) => await cli(args),
            readDiagnostics: async () => await readFile(join(directory, "logs", "daemon.log"), "utf8"),
            signal,
            sessionId,
            workspace,
            send: (message) => {
                if (socket === undefined) {
                    throw new Error("Daemon is not connected");
                }
                socket.send(message);
            },
            nextMessage,
            nextFrame,
            nextEvent: async () => {
                const pending = pendingEvents.shift();
                if (pending !== undefined) {
                    return pending;
                }
                for (;;) {
                    const message = await nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        pendingEvents.push(
                            ...decodeSessionEventEnvelope(message).events.map((event) => JSON.stringify(event)),
                        );
                        const event = pendingEvents.shift();
                        if (event !== undefined) {
                            return event;
                        }
                    }
                }
            },
        });
    } catch (cause) {
        const diagnostics = await collectLocalDaemonLogs(directory, 100, AbortSignal.timeout(5_000)).catch(
            (cause: unknown) => ({ collectionFailure: inspect(cause) }),
        );
        process.stderr.write(
            `Real ${specification.label} ${launch} scenario failed: ${inspect(cause, { depth: 8 })}\n` +
                `Recent test transport frames:\n${recentFrames.join("\n")}\n` +
                `Daemon diagnostics:\n${inspect(diagnostics, { depth: 8 }).slice(-32_768)}\n`,
        );
        throw cause;
    } finally {
        try {
            if (launch === "managed") {
                await cli(["quit"], AbortSignal.timeout(15_000));
            }
        } finally {
            controller.abort();
            signal.removeEventListener("abort", stopWaiting);
            await runtime?.catch(() => {});
            for (const connection of server.clients) {
                connection.terminate();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (relay.listening) {
                await new Promise<void>((resolve) => relay.close(() => resolve()));
            }
            await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
        }
    }
}

/** Opens a new conversation through the same preparation command the Web uses. */
export async function prepareNewRealSession(
    peer: Parameters<Parameters<typeof withRealDaemon>[2]>[0],
    agentId: string,
): Promise<string> {
    const requestId = randomUUID();
    const sessionId = `draft-${randomUUID()}`;
    peer.send(
        encodeSessionPrepareCommand({
            kind: "session.prepare",
            requestId,
            sessionId,
            agentId,
            bindingId: peer.bindingId,
            directoryId: "default",
            additionalDirectoryIds: [],
        }),
    );
    for (;;) {
        peer.signal.throwIfAborted();
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                return ready.sessionId;
            }
        }
    }
}
