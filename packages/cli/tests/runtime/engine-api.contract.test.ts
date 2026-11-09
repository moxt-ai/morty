import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import { listen, port } from "@morty-build/platform-test-support/websocket";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { MortyRuntimeEngine } from "../../src/exports/engine.ts";
import { memoryRuntimeCredentials } from "../support/runtime-credentials.ts";

it("Given an explicit data directory, When a host constructs Engine and reopens its store, Then construction has no side effects and saved connections survive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-api-"));
    const signal = AbortSignal.timeout(5_000);
    const params = { engineDataDir: join(directory, "data"), agentLaunchEnvironment: { PATH: "" } };
    try {
        const engine = new MortyRuntimeEngine(params);
        expect(await readdir(directory)).toEqual([]);
        const store = engine.getConnectionManager();
        expect(engine.getConnectionManager()).toBe(store);
        const connection = await store.save(
            {
                channelId: "embedded_channel",
                defaultWorkspace: join(directory, "workspace"),
                pairingId: "embedded_pairing",
                relayOrigin: new URL("https://relay.example.com/"),
                runtimeCredential: "a".repeat(43),
                runtimeId: "embedded_runtime",
            },
            signal,
        );
        const reopened = new MortyRuntimeEngine(params).getConnectionManager();
        expect(await reopened.read(connection.connectionId, signal)).toEqual(connection);
        expect(await reopened.list(signal)).toEqual([connection]);
        await reopened.setActivation(connection.connectionId, "stopped", signal);
        expect(await store.read(connection.connectionId, signal)).toMatchObject({ activation: "stopped" });
        await reopened.remove(connection.connectionId, signal);
        expect(await store.list(signal)).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a cancelled connection lookup, When another caller lists saved connections, Then cancellation does not poison lazy initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-cancel-"));
    try {
        const engine = new MortyRuntimeEngine({ engineDataDir: directory, agentLaunchEnvironment: { PATH: "" } });
        const cancelled = AbortSignal.abort(new Error("Lookup cancelled"));
        await expect(engine.getConnectionManager().list(cancelled)).rejects.toBe(cancelled.reason);
        const signal = AbortSignal.timeout(5_000);
        expect(
            await Promise.all([engine.getConnectionManager().list(signal), engine.getConnectionManager().list(signal)]),
        ).toEqual([[], []]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given first-use initialization is pending, When its owner and one waiter cancel, Then another waiter initializes successfully and later callers reuse that installation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-first-use-"));
    try {
        const engine = new MortyRuntimeEngine({ engineDataDir: directory, agentLaunchEnvironment: { PATH: "" } });
        const manager = engine.getConnectionManager();
        const owner = new AbortController();
        const waiter = new AbortController();
        const ownerReason = new Error("Initialization owner cancelled");
        const waiterReason = new Error("Initialization waiter cancelled");
        const first = manager.list(owner.signal);
        const cancelledWaiter = manager.list(waiter.signal);
        const survivingWaiter = manager.list(AbortSignal.timeout(5_000));
        // All three calls entered synchronously, before the first filesystem await completes.
        const pending = Promise.allSettled([first, cancelledWaiter, survivingWaiter]);
        waiter.abort(waiterReason);
        owner.abort(ownerReason);
        expect(await pending).toEqual([
            { status: "rejected", reason: ownerReason },
            { status: "rejected", reason: waiterReason },
            { status: "fulfilled", value: [] },
        ]);
        expect(await manager.list(AbortSignal.timeout(5_000))).toEqual([]);
        expect(await readdir(directory)).toEqual(
            expect.arrayContaining(["current.json", expect.stringMatching(/^min_[a-f0-9]{32}$/)]),
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a fresh Engine data directory, When a host concurrently saves connections on first use, Then only one complete pairing becomes active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-concurrent-"));
    const signal = AbortSignal.timeout(5_000);
    try {
        const manager = new MortyRuntimeEngine({
            engineDataDir: directory,
            agentLaunchEnvironment: { PATH: "" },
        }).getConnectionManager();
        const results = await Promise.allSettled(
            Array.from({ length: 32 }, (_, index) =>
                manager.save(
                    {
                        channelId: `concurrent_channel_${index}`,
                        defaultWorkspace: join(directory, "workspace"),
                        pairingId: `concurrent_pairing_${index}`,
                        relayOrigin: new URL("https://relay.example.com/"),
                        runtimeCredential: "a".repeat(43),
                        runtimeId: `concurrent_runtime_${index}`,
                    },
                    signal,
                ),
            ),
        );
        const saved = await manager.list(signal);
        expect(saved).toHaveLength(1);
        expect(
            results.some(
                (result) => result.status === "fulfilled" && result.value.connectionId === saved[0]?.connectionId,
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

it("Given installation initialization fails, When the host fixes the data directory and tries again, Then Engine does not cache the failed initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-retry-"));
    const data = join(directory, "data");
    const signal = AbortSignal.timeout(5_000);
    try {
        await writeFile(data, "not a directory");
        const manager = new MortyRuntimeEngine({
            engineDataDir: data,
            agentLaunchEnvironment: { PATH: "" },
        }).getConnectionManager();
        await expect(manager.list(signal)).rejects.toMatchObject({ code: "installation_unavailable" });
        await rm(data);
        expect(await manager.list(signal)).toEqual([]);
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
        const manager = engine.getConnectionManager();
        const saved = await manager.save(
            {
                channelId: "loop_channel",
                defaultWorkspace: join(directory, "workspace"),
                pairingId: "loop_pairing",
                relayOrigin: new URL(origin),
                runtimeCredential: "a".repeat(73),
                runtimeId: "loop_runtime",
            },
            deadline,
        );
        const connections = [
            { kind: "saved", connectionId: saved.connectionId },
            {
                kind: "provided",
                connection: {
                    channelId: "provided_channel",
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
        expect(await manager.list(deadline)).toEqual([
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
