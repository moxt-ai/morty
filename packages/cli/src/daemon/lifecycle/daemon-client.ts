import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { releaseEntry, requireInstalledRelease } from "../../installation/releases.ts";
import { daemonLockExists } from "../../storage/daemon/daemon-lock.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, sendLocalRequest } from "../control/local-client.ts";
import { decodeLifecycleResponse, type LifecycleResponse } from "../control/protocol.ts";

async function spawnDaemon(entry: string): Promise<ChildProcess> {
    if (entry === undefined) {
        throw new Error("The CLI entrypoint is missing");
    }
    const child = spawn(process.execPath, [entry, "__daemon"], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    await once(child, "spawn");
    child.unref();
    return child;
}

async function launchDaemon(version: string, entry: string): Promise<ChildProcess> {
    process.stdout.write(`Starting morty daemon ${version}\n`);
    return await spawnDaemon(entry);
}

async function waitForDaemonExit(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!deadline.aborted) {
        if (!(await daemonLockExists(stateDirectory))) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(finish, 20);
            const abort = (): void => finish(deadline.reason);
            function finish(cause?: unknown): void {
                clearTimeout(timeout);
                deadline.removeEventListener("abort", abort);
                cause === undefined ? resolve() : reject(cause);
            }
            deadline.addEventListener("abort", abort, { once: true });
        });
    }
    throw deadline.reason;
}

// Only the verified durable installation may own the long-lived daemon.
export async function ensureDaemon(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<string> {
    const running = await readDaemonVersion(stateDirectory, signal);
    if (running !== null) {
        return running;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    const installed = await requireInstalledRelease(signal);
    return await waitForDaemon(stateDirectory, installed.version, releaseEntry(installed), deadline);
}

// Status identifies the currently running daemon.
export async function readDaemonVersion(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<string | null> {
    try {
        const response = decodeLifecycleResponse(await sendLocalRequest(stateDirectory, { kind: "status" }, signal));
        if (response.kind === "status") {
            return response.daemon.version;
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
    return null;
}

async function waitForDaemon(
    stateDirectory: InstallationDirectory,
    version: string,
    entry: string,
    signal: AbortSignal,
): Promise<string> {
    let daemonStarted = false;
    let child: ChildProcess | undefined;
    while (!signal.aborted) {
        try {
            const response = decodeLifecycleResponse(
                await sendLocalRequest(stateDirectory, { kind: "status" }, signal),
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (response.kind === "status") {
                if (daemonStarted) {
                    process.stdout.write(`Morty daemon ${version} started\n`);
                }
                return response.daemon.version;
            }
            throw new Error("The daemon could not return its status");
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            // A competing launcher can exit successfully after losing the lock.
            // Check the shared endpoint first and keep waiting for its owner.
            if (
                child !== undefined &&
                (child.signalCode !== null ||
                    (child.exitCode !== null && (child.exitCode !== 0 || !(await daemonLockExists(stateDirectory)))))
            ) {
                throw new Error("The daemon exited before becoming ready");
            }
            if (!daemonStarted) {
                child = await launchDaemon(version, entry);
                daemonStarted = true;
            }
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(finish, 50);
                const abort = (): void => finish(signal.reason);
                function finish(cause?: unknown): void {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", abort);
                    cause === undefined ? resolve() : reject(cause);
                }
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    }
    throw signal.reason;
}

export async function stopDaemon(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<Extract<LifecycleResponse, { kind: "stopped" }>> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    while (true) {
        deadline.throwIfAborted();
        try {
            const response = decodeLifecycleResponse(
                await sendLocalRequest(stateDirectory, { kind: "stop" }, deadline),
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (response.kind !== "stopped") {
                throw new Error("The Morty daemon returned an unexpected response");
            }
            await waitForDaemonExit(stateDirectory, deadline);
            return response;
        } catch (cause) {
            deadline.throwIfAborted();
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!(await daemonLockExists(stateDirectory))) {
                return { kind: "stopped" };
            }
            // The owner may still be copying data or discovering Agents. Its missing
            // socket is not proof of shutdown: wait for control or report the deadline.
            await delay(50, undefined, { signal: deadline });
        }
    }
}
