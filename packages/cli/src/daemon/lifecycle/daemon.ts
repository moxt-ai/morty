import { realpath } from "node:fs/promises";
import { refreshAgentCatalog } from "../../engine/runtime/catalog/refresh-agent-catalog.ts";
import type { RuntimeConfig } from "../../engine/runtime/config.ts";
import { RuntimeInstallationStore } from "../../engine/runtime/connection/runtime-installation-store.ts";
import { prepareRuntimeConnection } from "../../engine/runtime/pairing.ts";
import { RuntimeLoop } from "../../engine/runtime/runtime-loop.ts";
import { RuntimeAgentProcesses } from "../../engine/session/process/runtime-agent-processes.ts";
import { RuntimeTurnActivity } from "../../engine/session/turn/runtime-turn-activity.ts";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { logDirectory, WORKER_LIFECYCLE_LOG_FILENAME } from "../../engine/storage/logs/log-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { releaseEntry, requireInstalledRelease } from "../../installation/releases.ts";
import { acquireDaemonLock } from "../../storage/daemon/daemon-lock.ts";
import { prepareMortyEngineDataDir, resolveMaxAcpProcesses } from "../config.ts";
import { sendLocalRequest } from "../control/local-client.ts";
import { serveLocalControl } from "../control/local-server.ts";
import { openMortyControlInstallation } from "../pairing/pair-local-machine.ts";
import { surviveUnhandledRejections, type UnhandledRejectionGuard } from "./unhandled-rejection.ts";

class DaemonRuntimeError extends Error {
    readonly code = "worker_runtime_failed";
    constructor(connectionId: string, cause: unknown) {
        super(`Runtime ${connectionId} failed`, { cause });
    }
}

export async function reloadDaemon(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, "manager", { kind: "reload" }, signal);
        if (
            typeof response !== "object" ||
            response === null ||
            !("kind" in response) ||
            response.kind !== "reloaded"
        ) {
            throw new Error("Saved configuration could not be applied to the running daemon");
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
}

/** Releases idle Agent processes of a running daemon; succeeds when no daemon is running. */
export async function releaseIdleAgentProcesses(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, "manager", { kind: "release" }, signal);
        if (typeof response === "object" && response !== null && "kind" in response && response.kind === "released") {
            return;
        }
        throw new Error("The running daemon cannot release Agent sessions. Run `morty update` to update it first.");
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
}

export async function runDaemon(version: string, signal: AbortSignal): Promise<void> {
    const installed = await requireInstalledRelease(signal);
    const invoked = process.argv[1];
    if (
        installed.version !== version ||
        invoked === undefined ||
        (await realpath(invoked)) !== (await realpath(releaseEntry(installed)))
    ) {
        throw new Error("Morty release changed during startup; retry start using the selected installation");
    }
    // Install before any await: an unhandled rejection during startup itself
    // must not kill the daemon before the guard exists.
    const rejectionGuard = surviveUnhandledRejections();
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    try {
        await runDaemonRuntime(version, combined, shutdown, rejectionGuard);
    } catch (cause) {
        const control = await openMortyControlInstallation(AbortSignal.timeout(5_000), process.env);
        new BoundedLineLog(logDirectory(control.stateDirectory), WORKER_LIFECYCLE_LOG_FILENAME, 512 * 1024).record(
            JSON.stringify({
                kind: "daemon_failed",
                message: cause instanceof Error ? cause.message : "Daemon failed",
            }),
        );
        throw cause;
    } finally {
        shutdown.abort();
        rejectionGuard.release();
    }
}

async function runDaemonRuntime(
    version: string,
    combined: AbortSignal,
    shutdown: AbortController,
    rejectionGuard: UnhandledRejectionGuard,
): Promise<void> {
    const control = await openMortyControlInstallation(combined, process.env);
    const releaseDaemon = await acquireDaemonLock(control.stateDirectory, "manager.lock");
    if (releaseDaemon === null) {
        return;
    }
    const lifecycleLog = new BoundedLineLog(
        logDirectory(control.stateDirectory),
        WORKER_LIFECYCLE_LOG_FILENAME,
        512 * 1024,
    );
    lifecycleLog.record(
        JSON.stringify({ kind: "daemon_started", pid: process.pid, version, timestamp: new Date().toISOString() }),
    );
    try {
        const engineDataDir = await prepareMortyEngineDataDir(version, combined, process.env);
        const installation = await RuntimeInstallationStore.open(engineDataDir, combined);
        rejectionGuard.bindStateDirectory(control.stateDirectory);
        const turnActivity = new RuntimeTurnActivity();
        const agentProcesses = new RuntimeAgentProcesses();
        const active = new Map<
            string,
            {
                readonly config: RuntimeConfig;
                readonly controller: AbortController;
                readonly completion: Promise<void>;
            }
        >();
        const fail = (connectionId: string, cause: unknown): void => {
            console.error(`Runtime ${connectionId} failed; stopping the daemon`, cause);
            shutdown.abort(new DaemonRuntimeError(connectionId, cause));
        };
        const reconcile = async (): Promise<void> => {
            const connections = await installation.listConnections(combined);
            const enabled = new Set(
                connections
                    .filter((connection) => connection.activation === "active")
                    .map((connection) => connection.connectionId),
            );
            for (const [id, running] of active) {
                if (enabled.has(id)) {
                    continue;
                }
                running.controller.abort();
                await running.completion;
                active.delete(id);
            }
            for (const connection of connections) {
                if (!enabled.has(connection.connectionId) || active.has(connection.connectionId)) {
                    continue;
                }
                try {
                    const config = await prepareRuntimeConnection(
                        installation,
                        connection,
                        combined,
                        process.env,
                        resolveMaxAcpProcesses(process.env),
                    );
                    const controller = new AbortController();
                    // Process diagnostics live beside the shared control directory,
                    // so every Runtime can include them in bug reports.
                    const loop = new RuntimeLoop(async () => config, {
                        processLogsDirectory: control.stateDirectory,
                        turnActivity,
                        agentProcesses,
                    });
                    const completion = loop
                        .run(AbortSignal.any([combined, controller.signal]))
                        .then(
                            () => {
                                if (!combined.aborted && !controller.signal.aborted) {
                                    fail(connection.connectionId, new Error("The Runtime stopped unexpectedly"));
                                }
                            },
                            (cause: unknown) => {
                                if (!combined.aborted && !controller.signal.aborted) {
                                    fail(connection.connectionId, cause);
                                }
                            },
                        )
                        .finally(() => active.delete(connection.connectionId));
                    active.set(connection.connectionId, { config, controller, completion });
                } catch (cause) {
                    combined.throwIfAborted();
                    fail(connection.connectionId, cause);
                    throw cause;
                }
            }
        };
        const refreshRunningCatalogs = async (connectionIds: ReadonlySet<string>): Promise<void> => {
            await Promise.all(
                [...connectionIds].map(async (connectionId) => {
                    const config = active.get(connectionId)?.config;
                    if (config?.rediscoverAgents === undefined) {
                        return;
                    }
                    try {
                        await refreshAgentCatalog(
                            config,
                            config.rediscoverAgents,
                            AbortSignal.any([combined, AbortSignal.timeout(90_000)]),
                        );
                    } catch (cause) {
                        combined.throwIfAborted();
                        // The Runtime keeps serving its previous catalog; the reload itself still applies.
                        console.error(`Runtime ${connectionId} could not refresh its Agent catalog`, cause);
                    }
                }),
            );
        };
        let reload: Promise<void> = Promise.resolve();
        const handle = async (request: unknown) => {
            if (typeof request === "object" && request !== null && "kind" in request) {
                if (request.kind === "status" || request.kind === "ensure") {
                    return { kind: "status", protocolVersion: 2, worker: { pid: process.pid, version } };
                }
                if (request.kind === "stop") {
                    return { kind: "stopped" };
                }
            }
            if (typeof request === "object" && request !== null && "kind" in request && request.kind === "release") {
                // Agents' own clients can continue the conversations that idle processes held.
                await agentProcesses.retireIdleProcesses();
                return { kind: "released" };
            }
            if (typeof request !== "object" || request === null || !("kind" in request) || request.kind !== "reload") {
                return { kind: "error", code: "invalid_reload", message: "Expected a configuration reload" };
            }
            // A reload, such as `morty start` after the user installs or signs in to an Agent, also re-reads the
            // Agent inventory of Runtimes that were already running; Runtimes it starts read it themselves.
            const running = new Set(active.keys());
            const pending = reload.then(reconcile).then(async () => await refreshRunningCatalogs(running));
            reload = pending.catch(() => undefined);
            await pending;
            return { kind: "reloaded" };
        };
        try {
            await reconcile();
            lifecycleLog.record(
                JSON.stringify({
                    kind: "daemon_ready",
                    pid: process.pid,
                    version,
                    timestamp: new Date().toISOString(),
                }),
            );
            const servers: readonly ("manager" | "worker")[] = ["manager"];
            const results = await Promise.allSettled(
                servers.map(async (endpoint) => {
                    try {
                        await serveLocalControl(
                            control.stateDirectory,
                            endpoint,
                            combined,
                            handle,
                            () => undefined,
                            (response) => {
                                if (
                                    typeof response === "object" &&
                                    response !== null &&
                                    "kind" in response &&
                                    response.kind === "stopped"
                                ) {
                                    shutdown.abort();
                                }
                            },
                        );
                    } finally {
                        shutdown.abort();
                    }
                }),
            );
            for (const result of results) {
                if (result.status === "rejected") {
                    throw result.reason;
                }
            }
            if (shutdown.signal.reason instanceof DaemonRuntimeError) {
                throw shutdown.signal.reason;
            }
        } finally {
            shutdown.abort();
            await reload;
            await Promise.all([...active.values()].map((running) => running.completion));
        }
    } finally {
        await releaseDaemon();
    }
}
