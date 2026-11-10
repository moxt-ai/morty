import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { collectLocalDaemonLogs } from "../../src/cli/handler/logs/logic/collect-local-logs.ts";

interface PairingRelay {
    readonly claims: Array<Readonly<Record<string, unknown>>>;
    readonly dispose: () => Promise<void>;
    readonly origin: string;
}

/**
 * Accepts the pairing redemption and records the Agent directory the machine advertised. Only the
 * Agent inventory is under test; the redemption response is the Relay's own contract.
 */
async function createPairingRelay(): Promise<PairingRelay> {
    const claims: Array<Readonly<Record<string, unknown>>> = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((request, response) => {
        // A daemon the CLI reloads after pairing also dials the Relay; only redemptions are answered.
        if (request.method !== "POST" || request.url?.endsWith("/redeem") !== true) {
            response.writeHead(404).end();
            return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            claims.push(JSON.parse(body) as Readonly<Record<string, unknown>>);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    computerId: "unattended-computer",
                    runtimeCredential: "u".repeat(32),
                }),
            );
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await listen(server);
    return {
        claims,
        dispose: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        },
        origin: `http://127.0.0.1:${port(server)}`,
    };
}

// Empty overrides short-circuit discovery for every supported Agent, so no machine installation
// can satisfy the pairing. This keeps the scenario independent of what the developer has on PATH.
function agentlessEnvironment(stateDirectory: string): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({
        MORTY_CLAUDE_PATH: "",
        MORTY_CODEX_PATH: "",
        MORTY_PI_PATH: "",
        MORTY_STATE_DIRECTORY: stateDirectory,
        PATH: "",
    });
}

/** Runs the built CLI with `input` piped to its standard input. */
async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    input = "",
): Promise<{ readonly code: number | null; readonly stderr: string }> {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...arguments_], {
        env: environment,
        signal: AbortSignal.timeout(60_000),
        stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr };
}

describe("pairing a machine without a local Agent", () => {
    it("Given a pairing code piped to the CLI, When the user pairs with --code-stdin, Then the machine redeems that code without it appearing in the command line", async () => {
        const home = await mkdtemp(join(tmpdir(), "morty-unattended-computer-"));
        const relay = await createPairingRelay();
        const environment = { ...agentlessEnvironment(join(home, "state")), HOME: home, TMPDIR: home };
        const pairing = [
            "pair",
            "--url",
            relay.origin,
            "--computer",
            "unattended-computer",
            "--workspace",
            join(home, "workspace"),
            "--code-stdin",
        ];

        try {
            const paired = await runCli(pairing, environment, "ABCD-EFGH-JKLM-NPQR-STUV\n");

            expect(
                paired.code,
                paired.stderr +
                    JSON.stringify(await collectLocalDaemonLogs(join(home, "state"), 20, AbortSignal.timeout(5_000))),
            ).toBe(0);
            expect(relay.claims).toHaveLength(1);
            expect(relay.claims[0]).toMatchObject({ pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV" });
            expect(pairing.join(" ")).not.toContain("ABCD-EFGH");
        } finally {
            await runCli(["quit"], environment);
            await relay.dispose();
            await rm(home, { force: true, recursive: true });
        }
    });

    it("Given no supported Agent is discoverable, When the machine redeems its pairing, Then it pairs and advertises an empty Agent directory", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-unattended-computer-"));
        const relay = await createPairingRelay();

        try {
            const { MortyRuntimeEngine } = await import("../../src/exports/engine.ts");
            const engine = new MortyRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: agentlessEnvironment(stateDirectory),
            });

            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    computerId: "unattended-computer",
                    relayOrigin: relay.origin,
                },
                AbortSignal.timeout(20_000),
            );

            expect(
                await engine.getConnectionManager().read(paired.connectionId, AbortSignal.timeout(5_000)),
            ).toMatchObject({
                computerId: "unattended-computer",
            });
            expect(relay.claims).toHaveLength(1);
            expect(relay.claims[0]).toMatchObject({
                agents: [],
                pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
            });
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an unattended machine is already paired, When another Engine reads its saved connection, Then pairing is retained without redeeming again", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-unattended-resume-"));
        const relay = await createPairingRelay();
        const environment = agentlessEnvironment(stateDirectory);

        try {
            const { MortyRuntimeEngine } = await import("../../src/exports/engine.ts");
            const engine = new MortyRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: environment,
            });
            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    computerId: "unattended-computer",
                    relayOrigin: relay.origin,
                },
                AbortSignal.timeout(20_000),
            );

            const resumed = await new MortyRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: environment,
            })
                .getConnectionManager()
                .read(paired.connectionId, AbortSignal.timeout(20_000));

            expect(resumed.connectionId).toBe(paired.connectionId);
            expect(resumed).toEqual(paired);
            expect(relay.claims).toHaveLength(1);
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
