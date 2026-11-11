import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    encodeRuntimeLivenessReadyEvent,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_SUCCESSOR_CREDENTIAL_HEADER,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";
import { MortyRuntimeEngine } from "../../src/engine/runtime/engine.ts";
import { memoryRuntimeCredentials } from "../support/runtime-credentials.ts";

it("Given an explicit data directory, When a host constructs Engine and reopens its store, Then construction has no side effects and saved connections survive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-api-"));
    const signal = AbortSignal.timeout(5_000);
    const params = { engineDataDir: join(directory, "data"), agentLaunchEnvironment: { PATH: "" } };
    try {
        new MortyRuntimeEngine(params);
        expect(await readdir(directory)).toEqual([]);
        const store = await RuntimeInstallationStore.open(params.engineDataDir, signal);
        const connection = await store.saveConnection(
            {
                computerId: "embedded_channel",
                defaultWorkspace: join(directory, "workspace"),
                relayOrigin: new URL("https://relay.example.com/"),
                runtimeCredential: "a".repeat(43),
            },
            signal,
        );
        const reopened = await RuntimeInstallationStore.open(params.engineDataDir, signal);
        expect(await reopened.readConnection(connection.pairingGeneration, signal)).toEqual(connection);
        expect(await reopened.listConnections(signal)).toEqual([connection]);
        await reopened.setConnectionActivation(connection.pairingGeneration, "stopped", signal);
        expect(await store.readConnection(connection.pairingGeneration, signal)).toMatchObject({
            activation: "stopped",
        });
        await reopened.removeConnection(connection.pairingGeneration, signal);
        expect(await store.listConnections(signal)).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a fresh installation, When a host concurrently saves connections, Then only one complete pairing becomes active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-concurrent-"));
    const signal = AbortSignal.timeout(5_000);
    try {
        const manager = await RuntimeInstallationStore.open(directory, signal);
        const results = await Promise.allSettled(
            Array.from({ length: 32 }, (_, index) =>
                manager.saveConnection(
                    {
                        computerId: `concurrent_channel_${index}`,
                        defaultWorkspace: join(directory, "workspace"),
                        relayOrigin: new URL("https://relay.example.com/"),
                        runtimeCredential: "a".repeat(43),
                    },
                    signal,
                ),
            ),
        );
        const saved = await manager.listConnections(signal);
        expect(saved).toHaveLength(1);
        expect(
            results.some(
                (result) =>
                    result.status === "fulfilled" && result.value.pairingGeneration === saved[0]?.pairingGeneration,
            ),
        ).toBe(true);
        for (const result of results) {
            if (result.status === "rejected") {
                expect(result.reason).toMatchObject({ code: "pairing_busy" });
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given saved and provided connections with opaque credentials, When a host serves and cancels successive loops, Then both publish their Agent directory, disconnect before completion without saving the provided connection, and the saved connection presents the successor it saved next time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-loop-"));
    const catalogs: unknown[] = [];
    const requests: string[] = [];
    const authorizations: (string | undefined)[] = [];
    const successors: (string | undefined)[] = [];
    const http = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            catalogs.push(JSON.parse(body));
            response.writeHead(204).end();
        });
    });
    const relay = new WebSocketServer({ server: http });
    let disconnected = Promise.withResolvers<void>();
    let revoke = false;
    relay.on("connection", (socket, request) => {
        requests.push(request.url ?? "");
        authorizations.push(request.headers.authorization);
        const successor = request.headers[RUNTIME_SUCCESSOR_CREDENTIAL_HEADER];
        successors.push(typeof successor === "string" ? successor : undefined);
        socket.once("close", () => disconnected.resolve());
        if (revoke) {
            socket.close(1008, "Runtime revoked");
            return;
        }
        socket.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
        socket.on("message", (encoded) => {
            if (encoded.toString() === RUNTIME_HEARTBEAT_MESSAGE) {
                socket.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
            }
        });
    });
    await listen(http);
    const deadline = AbortSignal.timeout(20_000);
    try {
        const origin = `http://127.0.0.1:${port(http)}`;
        const engine = new MortyRuntimeEngine({
            engineDataDir: join(directory, "data"),
            agentLaunchEnvironment: {
                PATH: "",
                MORTY_CLAUDE_PATH: "",
                MORTY_CODEX_PATH: "",
                MORTY_PI_PATH: "",
                MORTY_OPENCODE_PATH: "",
            },
        });
        const manager = await RuntimeInstallationStore.open(join(directory, "data"), deadline);
        const saved = await manager.saveConnection(
            {
                computerId: "loop_channel",
                defaultWorkspace: join(directory, "workspace"),
                relayOrigin: new URL(origin),
                runtimeCredential: "a".repeat(73),
            },
            deadline,
        );
        const connections = [
            { kind: "saved", pairingGeneration: saved.pairingGeneration },
            {
                kind: "provided",
                connection: {
                    computerId: "provided_channel",
                    defaultWorkspace: saved.defaultWorkspace,
                    relayUrl: `ws://127.0.0.1:${port(http)}/morty/api/v1/runtimes/connect`,
                    credentials: memoryRuntimeCredentials("b".repeat(73)),
                },
            },
        ] as const;
        for (const connection of connections) {
            const shutdown = new AbortController();
            let online = false;
            const counts: number[] = [];
            await engine.runLoop({
                connection,
                signal: AbortSignal.any([deadline, shutdown.signal]),
                onConnectionStatus: (status) => {
                    if (status === "online") {
                        online = true;
                        shutdown.abort();
                    }
                },
                onExecutionCountChange: (count) => counts.push(count),
            });
            await disconnected.promise;
            disconnected = Promise.withResolvers<void>();
            expect(online).toBe(true);
            expect(counts.at(-1)).toBe(0);
        }
        expect(requests).toHaveLength(2);
        expect(authorizations).toEqual([`Bearer ${"a".repeat(73)}`, `Bearer ${"b".repeat(73)}`]);
        expect(catalogs).toHaveLength(2);
        expect(catalogs).toEqual([expect.objectContaining({ agents: [] }), expect.objectContaining({ agents: [] })]);
        const [savedSuccessor] = successors;
        expect(savedSuccessor).toMatch(/^[A-Za-z0-9_-]{73}$/u);
        expect(await manager.listConnections(deadline)).toEqual([
            { ...saved, credentials: { current: savedSuccessor, successor: null } },
        ]);

        revoke = true;
        await expect(engine.runLoop({ connection: connections[0], signal: deadline })).rejects.toMatchObject({
            code: "runtime_relay_revoked",
        });
        await disconnected.promise;
        expect(authorizations.at(-1)).toBe(`Bearer ${savedSuccessor}`);
    } finally {
        for (const socket of relay.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
        await rm(directory, { recursive: true, force: true });
    }
});
