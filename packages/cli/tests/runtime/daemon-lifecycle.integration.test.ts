import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { decodeDaemonToServiceMessage } from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import cliPackage from "../../package.json" with { type: "json" };
import { controlSocketPath } from "../../src/daemon/control/local-client.ts";
import { openMortyInstallation } from "../../src/daemon/pairing/pair-local-machine.ts";
import type { InstallationDirectory } from "../../src/engine/storage/installation/installation-files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

describe("Morty daemon lifecycle", () => {
    it.each(["workspace", "database"])(
        "Given an enabled Runtime has a broken %s, When the user starts the daemon, Then startup fails and releases its lock instead of claiming success",
        async (broken) => {
            const directory = await mkdtemp(join(tmpdir(), "morty-worker-fail-fast-"));
            temporaryDirectories.push(directory);
            const workspace = join(directory, "workspace");
            await mkdir(workspace);
            const environment = { ...process.env, MORTY_STATE_DIRECTORY: join(directory, "state") };
            const signal = AbortSignal.timeout(30_000);
            const installation = await openMortyInstallation(signal, environment);
            const computerId = "channel_start_failure";
            await installation.saveConnection(
                {
                    computerId,
                    defaultWorkspace: workspace,
                    relayOrigin: new URL("http://127.0.0.1:1"),
                    runtimeCredential: "a".repeat(43),
                },
                signal,
            );
            if (broken === "workspace") {
                await rm(workspace, { recursive: true });
                await writeFile(workspace, "not a directory");
            } else {
                const sessions = join(installation.stateDirectory, "sessions");
                await mkdir(sessions, { recursive: true });
                const hash = createHash("sha256").update(computerId).digest("hex");
                await writeFile(join(sessions, `${hash}.sqlite`), "invalid SQLite database");
            }
            try {
                const result = await runCli(["start"], environment, signal);
                expect(result.code).toBe(1);
                expect(result.stdout).not.toContain("Morty daemon is running.");
                const control = await openMortyInstallation(signal, environment);
                await expect(readFile(join(control.stateDirectory, "worker.lock"))).rejects.toMatchObject({
                    code: "ENOENT",
                });
            } finally {
                await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
            }
        },
    );
    it("Given the daemon is stopped, When the user runs morty start, Then the daemon is running without requiring a connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-manager-start-"));
        temporaryDirectories.push(stateRoot);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: stateRoot };

        try {
            const started = await runCli(["start"], environment, AbortSignal.timeout(60_000));

            expect(started.code).toBe(0);
            expect(started.stderr).toBe("");
            expect(started.stdout).toContain(`Starting morty daemon ${cliPackage.version}\n`);
            expect(started.stdout).toContain(`Morty daemon ${cliPackage.version} started\n`);
            expect(started.stdout).toContain("Morty daemon is running.\n");

            const ensured = await runCli(["start"], environment, AbortSignal.timeout(60_000));
            expect(ensured).toEqual({ code: 0, stderr: "", stdout: "Morty daemon is running.\n" });
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    });

    it("Given no daemon is running, When saved pairings are listed, Then the CLI completes without starting a daemon", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-local-list-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: directory };
        const deadline = AbortSignal.timeout(30_000);
        const result = await runCli(["pair", "list"], environment, deadline);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("Starting morty");
        const control = await openMortyInstallation(deadline, environment);
        await expect(readFile(join(control.stateDirectory, "daemon.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("Given another control client remains connected, When the CLI quits, Then the daemon exits", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-manager-quit-"));
        temporaryDirectories.push(stateRoot);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: stateRoot };
        const deadline = AbortSignal.timeout(60_000);
        let heldConnection: Socket | undefined;
        try {
            const started = await runCli(["start"], environment, deadline);
            expect(started.code, started.stderr).toBe(0);
            const control = await openMortyInstallation(deadline, environment);
            heldConnection = await holdControlConnection(control.stateDirectory, deadline);
            expect(await runCli(["quit"], environment, deadline)).toEqual({
                code: 0,
                stderr: "",
                stdout: "Morty daemon stopped.\n",
            });
            for (const name of ["daemon.lock"]) {
                await expect(readFile(join(control.stateDirectory, name), "utf8")).rejects.toMatchObject({
                    code: "ENOENT",
                });
            }
        } finally {
            heldConnection?.destroy();
            await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    });
});

describe("Morty pairing lifecycle", () => {
    it.each(["stop", "remove"])(
        "Given an unpaired installation, When the user runs pair %s, Then the CLI explains how to pair without requiring an identifier",
        async (operation) => {
            const stateRoot = await mkdtemp(join(tmpdir(), "morty-unpaired-lifecycle-"));
            temporaryDirectories.push(stateRoot);
            const environment = { ...process.env, MORTY_STATE_DIRECTORY: stateRoot };
            const result = await runCli(["pair", operation], environment, AbortSignal.timeout(30_000));
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("No machine is paired. Run Morty setup first.");
        },
    );
    it("Given a paired machine, When the user stops, restarts and removes its current pairing without an identifier, Then the CLI shows each state without exposing an internal generation", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "morty-manager-pairing-lifecycle-"));
        temporaryDirectories.push(stateRoot);
        const executableDirectory = join(stateRoot, "empty-path");
        const workspace = join(stateRoot, "workspace");
        await Promise.all([mkdir(executableDirectory), mkdir(workspace)]);
        const environment = {
            ...process.env,
            MORTY_STATE_DIRECTORY: join(stateRoot, "morty"),
            PATH: executableDirectory,
        };
        const deadline = AbortSignal.timeout(60_000);
        const relay = await startRelay();
        const installation = await openMortyInstallation(deadline, environment);
        const control = await openMortyInstallation(deadline, environment);
        const connection = await installation.saveConnection(
            {
                computerId: "computer_test",
                defaultWorkspace: workspace,
                relayOrigin: relay.origin,
                runtimeCredential: "a".repeat(43),
            },
            deadline,
        );

        try {
            const started = await runCli(["start"], environment, deadline);
            expect(started.code, started.stderr).toBe(0);
            const initiallyListed = await runCli(["pair", "list"], environment, deadline);
            expect(initiallyListed.code).toBe(0);
            expect(initiallyListed.stdout).toContain("computer_id");
            expect(initiallyListed.stdout).toContain(connection.computerId);
            expect(initiallyListed.stdout).not.toContain(connection.pairingGeneration);

            const daemonPid = await readFile(join(control.stateDirectory, "daemon.lock"), "utf8");
            const outputPath = join(stateRoot, "pairings.json");
            await writeFile(outputPath, "", { mode: 0o600 });
            const listedAsJson = await runCli(["pair", "list", `--output-json=${outputPath}`], environment, deadline);
            expect(listedAsJson).toEqual({ code: 0, stderr: "", stdout: "" });
            expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
                {
                    computer_id: "computer_test",
                    status: "active",
                    workspace,
                },
            ]);

            const missingOutput = await runCli(
                ["pair", "list", `--output-json=${join(stateRoot, "missing.json")}`],
                environment,
                deadline,
            );
            expect(missingOutput.code).toBe(1);
            expect(missingOutput.stderr).toContain("The JSON output file does not exist");

            const stopped = await runCli(["pair", "stop"], environment, deadline);
            expect(stopped.code).toBe(0);
            expect(stopped.stdout).toBe("Pairing stopped.\n");

            expect(await readFile(join(control.stateDirectory, "daemon.lock"), "utf8")).toBe(daemonPid);
            const listedStopped = await runCli(["pair", "list"], environment, deadline);
            expect(listedStopped.stdout).toContain(connection.computerId);
            expect(listedStopped.stdout).toContain("stopped");

            const quit = await runCli(["quit"], environment, deadline);
            expect(quit.code).toBe(0);
            const listedAfterRestart = await runCli(["pair", "list"], environment, deadline);
            expect(listedAfterRestart.stdout).toContain(connection.computerId);
            expect(listedAfterRestart.stdout).toContain("stopped");

            const resumed = await runCli(["start"], environment, deadline);
            expect(resumed.code, resumed.stderr).toBe(0);
            const listedActive = await runCli(["pair", "list"], environment, deadline);
            expect(listedActive.stdout).toContain("active");
            const removed = await runCli(["pair", "remove"], environment, deadline);
            expect(removed.code).toBe(0);
            expect(removed.stdout).toBe("Pairing removed.\n");

            const listedRemoved = await runCli(["pair", "list"], environment, deadline);
            expect(listedRemoved.stdout).not.toContain(connection.computerId);
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
            await relay.close();
        }
    }, 75_000);
});

async function startRelay(ready = true): Promise<{ readonly origin: URL; readonly close: () => Promise<void> }> {
    const catalogs = new Map<string, string>();
    const server = createServer((request, response) => {
        const path = request.url ?? "/";
        if (request.method === "PUT" && path.endsWith("/catalog")) {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                catalogs.set(path, body);
                response.writeHead(204).end();
            });
        } else if (request.method === "GET" && catalogs.has(path)) {
            response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(path));
        } else {
            response.writeHead(404).end();
        }
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
        socket.on("message", (bytes) => {
            const message = decodeDaemonToServiceMessage(bytes.toString());
            if (message.kind === "runtime.heartbeat") {
                socket.send(JSON.stringify({ kind: "runtime.heartbeat.ack" }));
            }
        });
        if (ready) {
            socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        }
    });
    await listen(server);
    return {
        origin: new URL(`http://127.0.0.1:${port(server)}`),
        close: async () => {
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve_) => sockets.close(() => resolve_()));
            server.closeAllConnections();
            await new Promise<void>((resolve_) => server.close(() => resolve_()));
        },
    };
}

async function holdControlConnection(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<Socket> {
    const token = (await readFile(join(stateDirectory, "daemon.token"), "utf8")).trim();
    const socket = createConnection({ allowHalfOpen: true, path: controlSocketPath(stateDirectory) });
    try {
        await new Promise<void>((resolve_, reject) => {
            const finish = (cause?: unknown): void => {
                signal.removeEventListener("abort", abort);
                socket.removeListener("connect", connected);
                socket.removeListener("error", finish);
                cause === undefined ? resolve_() : reject(cause);
            };
            const abort = (): void => finish(signal.reason);
            const connected = (): void => finish();
            socket.once("connect", connected);
            socket.once("error", finish);
            signal.addEventListener("abort", abort, { once: true });
        });
        socket.write(`${JSON.stringify({ kind: "status", token })}\n`);
        await new Promise<void>((resolve_, reject) => {
            let encoded = "";
            const finish = (cause?: unknown): void => {
                signal.removeEventListener("abort", abort);
                socket.removeListener("data", data);
                socket.removeListener("error", finish);
                cause === undefined ? resolve_() : reject(cause);
            };
            const abort = (): void => finish(signal.reason);
            const data = (chunk: Buffer): void => {
                encoded += chunk.toString("utf8");
                if (encoded.includes("\n")) {
                    finish();
                }
            };
            socket.on("data", data);
            socket.once("error", finish);
            signal.addEventListener("abort", abort, { once: true });
        });
        return socket;
    } catch (cause) {
        socket.destroy();
        throw cause;
    }
}

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...arguments_], {
        env: environment,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr, stdout };
}
