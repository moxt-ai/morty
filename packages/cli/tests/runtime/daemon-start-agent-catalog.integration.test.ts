import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { collectLocalDaemonLogs } from "../../src/cli/handler/logs/logic/collect-local-logs.ts";
import { openMortyInstallation } from "../../src/daemon/pairing/pair-local-machine.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...arguments_], {
        env: environment,
        signal,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr };
}

/** A Relay that accepts the Runtime and records every Agent catalog the daemon publishes. */
async function catalogRelay() {
    const published: string[] = [];
    const firstPublication = Promise.withResolvers<void>();
    const relay = createServer((request, response) => {
        if (request.method !== "PUT") {
            response.writeHead(404).end();
            return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            published.push(body);
            firstPublication.resolve();
            response.writeHead(204).end();
        });
    });
    const sockets = new WebSocketServer({ server: relay });
    sockets.on("connection", (socket) => {
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
    });
    await new Promise<void>((resolve_, reject) => {
        relay.once("error", reject);
        relay.listen(0, "127.0.0.1", resolve_);
    });
    const address = relay.address();
    if (address === null || typeof address === "string") {
        throw new Error("Relay did not bind a TCP port");
    }
    return {
        origin: new URL(`http://127.0.0.1:${address.port}`),
        published,
        firstPublication: firstPublication.promise,
        close: async () => {
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve_) => sockets.close(() => resolve_()));
            await new Promise<void>((resolve_, reject) => {
                relay.close((error) => (error === undefined || error === null ? resolve_() : reject(error)));
            });
        },
    };
}

it("Given a running daemon with a long temporary directory whose Agent catalog was read at startup, When the user runs `morty start` again, Then the daemon re-reads the local Agent inventory and republishes the catalog before start returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-start-agent-catalog-"));
    temporaryDirectories.push(directory);
    const temporaryFiles = join(directory, "long-temporary-directory-".repeat(6));
    await mkdir(temporaryFiles);
    // The Agent inventory is read from the same isolated environment on each start.
    const environment = {
        HOME: directory,
        MORTY_STATE_DIRECTORY: join(directory, "state"),
        PATH: dirname(process.execPath),
        TMPDIR: temporaryFiles,
    };
    const relay = await catalogRelay();

    const installation = await openMortyInstallation(AbortSignal.timeout(10_000), environment);
    await installation.saveConnection(
        {
            channelId: "start-catalog-channel",
            runtimeId: "runtime_start_catalog",
            pairingId: "",
            defaultWorkspace: directory,
            relayOrigin: relay.origin,
            runtimeCredential: "r".repeat(43),
        },
        AbortSignal.timeout(10_000),
    );
    try {
        const started = await runCli(["start"], environment, AbortSignal.timeout(60_000));
        expect(
            started.code,
            started.stderr +
                JSON.stringify(
                    await collectLocalDaemonLogs(environment.MORTY_STATE_DIRECTORY, 20, AbortSignal.timeout(5_000)),
                ),
        ).toBe(0);
        await relay.firstPublication;
        const publishedAtStartup = relay.published.length;

        const restarted = await runCli(["start"], environment, AbortSignal.timeout(60_000));

        expect(restarted.code, restarted.stderr).toBe(0);
        expect(relay.published).toHaveLength(publishedAtStartup + 1);
        expect(JSON.parse(relay.published.at(-1) ?? "{}")).toEqual(
            JSON.parse(relay.published[publishedAtStartup - 1] ?? "{}"),
        );
    } finally {
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        await relay.close();
    }
}, 120_000);
