import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeDaemonToServiceMessage,
    decodeNativeSessionResult,
    decodeSessionReadyEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionCancel,
    encodeNativeSessionCommand,
    encodeSessionCloseCommand,
    encodeSessionCreateCommand,
    encodeSessionListCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRestoreCommand,
    NATIVE_SESSION_REQUEST_KIND,
    type NativeSessionTarget,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { type RuntimeConfig, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { fakeAgentHarness } from "../support/agent-harness.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { memoryRuntimeCredentials } from "../support/runtime-credentials.ts";

// @no-uc: Compatibility; public Runtime commands and real ACP children verify embedding context isolation.
test("Given scoped environments, When Sessions run concurrently and restore, Then their children retain the right identity", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    try {
        const targets = await Promise.all([peer.create(), peer.create()]);
        const first = targets[0];
        if (first === undefined) {
            throw new Error("Expected the first native conversation");
        }
        await Promise.all(targets.map((target) => peer.prompt(target, crypto.randomUUID())));
        expect(await peer.launches()).toEqual(
            expect.arrayContaining(targets.map((target) => ({ context: JSON.stringify(target) }))),
        );
        expect((await peer.launches()).filter((launch) => launch.context !== null)).toEqual(
            expect.arrayContaining(targets.map((target) => ({ context: JSON.stringify(target) }))),
        );
        await peer.restart("runtime");
        peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId: "identify-a", targets: [first] }));
        const [entry] = decodeSessionsQueriedEvent(await peer.next("identify-a", ["session.queried"])).entries;
        if (entry === undefined) {
            throw new Error("Missing persisted native identity");
        }
        peer.send(
            encodeSessionRestoreCommand({
                kind: "session.restore",
                requestId: "restore-a",
                target: { harness: entry.agentId, sessionId: entry.sessionId },
            }),
        );
        await peer.next("restore-a", ["session.restored"]);
        expect((await peer.launches()).at(-1)).toEqual({ context: JSON.stringify(first) });
        expect(peer.agent.environment).not.toHaveProperty("MORTY_TEST_SESSION_CONTEXT");
    } finally {
        await peer.close();
    }
});

// @no-uc: Compatibility; native readers must not inherit a previously resolved execution environment.
test("Given an execution Session has scoped environment, When other conversations browse and find native history, Then query children stay unscoped", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    try {
        const seed = await peer.create();
        await peer.prompt(seed, "seed-history");
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base(),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId: "list-unscoped",
                action: "list",
                cursor: null,
            }),
        );
        const listed = decodeNativeSessionResult(await peer.next("list-unscoped", ["native.session.result"]));
        if (listed.action !== "list" || listed.entries[0] === undefined) {
            throw new Error("Expected the seeded native conversation");
        }
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base(),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId: "find-unscoped",
                action: "find",
                sessionId: listed.entries[0].sessionId,
            }),
        );
        expect(decodeNativeSessionResult(await peer.next("find-unscoped", ["native.session.result"]))).toMatchObject({
            action: "find",
            entry: { sessionId: listed.entries[0].sessionId },
        });
        expect((await peer.launches()).filter((launch) => launch.context !== null)).toEqual([
            { context: JSON.stringify(seed) },
        ]);
    } finally {
        await peer.close();
    }
});

// @no-uc: Technical regression; a failed shared reader must not block the next native-browser request.
test("Given a shared native reader crashes while listing, When a fresh conversation and the original conversation browse again, Then both see saved history without restarting", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    const list = async (requestId: string) => {
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base(),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId,
                action: "list",
                cursor: null,
            }),
        );
        return decodeDaemonToServiceMessage(
            await peer.next(requestId, ["native.session.result", "session.operation.failed"]),
        );
    };
    try {
        const seed = await peer.create();
        await peer.prompt(seed, "seed-history");
        const original = await list("list-before-crash");
        if (
            original.kind !== "native.session.result" ||
            original.action !== "list" ||
            original.entries[0] === undefined
        ) {
            throw new Error("Expected the seeded native conversation");
        }
        await peer.crashNextNativeList();
        expect(await list("list-that-crashes")).toMatchObject({
            kind: "session.operation.failed",
            code: "session_operation_failed",
        });
        for (const sessionId of ["new-browser", "first-browser"]) {
            const result = await list(`retry-after-crash-${sessionId}`);
            expect(result).toMatchObject({
                kind: "native.session.result",
                action: "list",
                entries: [
                    expect.objectContaining({
                        sessionId: original.entries[0].sessionId,
                        title: original.entries[0].title,
                    }),
                ],
            });
        }
    } finally {
        await peer.close();
    }
});

// @no-uc: Technical regression; native discovery, new destinations and canonical reimports must not share identity.
test("Given native history, When it is imported, reopened and forked, Then execution uses the destination or canonical Session", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    try {
        const seed = await peer.create();
        await peer.prompt(seed, "seed-history");
        await peer.restart("import-runtime");
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base(),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId: "native-list",
                action: "list",
                cursor: null,
            }),
        );
        const listed = decodeNativeSessionResult(await peer.next("native-list", ["native.session.result"]));
        if (listed.action !== "list" || listed.entries[0] === undefined) {
            throw new Error("Expected the seeded native conversation");
        }
        const sessionId = listed.entries[0].sessionId;
        const open = async (action: "import" | "fork", requestId: string) => {
            peer.send(
                encodeNativeSessionCommand({
                    ...peer.base(),
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId,
                    action,
                    sessionId,
                }),
            );
            const result = decodeNativeSessionResult(await peer.next(requestId, ["native.session.result"]));
            if (result.action !== "import" && result.action !== "fork") {
                throw new Error("Expected the native opening result");
            }
            return result.ready.target;
        };
        const imported = await open("import", "native-import");
        expect(imported.sessionId).toBe(listed.entries[0].sessionId);
        expect.soft((await peer.nativeRequests()).at(-1)).toMatchObject({ context: JSON.stringify(imported) });
        peer.send(encodeSessionCloseCommand({ target: imported, requestId: "close-imported", kind: "session.close" }));
        await peer.next("close-imported", ["session.closed"]);
        const canonical = await open("import", "native-reimport");
        expect(canonical).toEqual(imported);
        expect.soft((await peer.nativeRequests()).at(-1)).toMatchObject({ context: JSON.stringify(canonical) });
        const forked = await open("fork", "native-fork");
        expect(forked.sessionId).not.toBe(imported.sessionId);
        await peer.prompt(forked, "continue-fork");
        expect.soft((await peer.launches()).at(-1)).toMatchObject({ context: JSON.stringify(forked) });
    } finally {
        await peer.close();
    }
});

// @no-uc: Technical regression; concurrent native openings retain independent harness namespaces.
test.for(["import", "fork"] as const)(
    "Given separate Agents, When native %s commands run concurrently, Then both harness-owned destinations remain usable",
    async (action, { signal }) => {
        const peer = await runtimePeer(signal);
        try {
            const seed = await peer.create();
            await peer.prompt(seed, "seed-history");
            await peer.restart("competing-runtime");
            const candidates: { agentId: string; sessionId: string }[] = [];
            for (const agentId of ["codex", "other-codex"]) {
                const requestId = `list-${agentId}`;
                peer.send(
                    encodeNativeSessionCommand({
                        ...peer.base(agentId),
                        kind: NATIVE_SESSION_REQUEST_KIND,
                        requestId,
                        action: "list",
                        cursor: null,
                    }),
                );
                const result = decodeNativeSessionResult(await peer.next(requestId, ["native.session.result"]));
                if (result.action !== "list" || result.entries[0] === undefined) {
                    throw new Error("Expected native history for each Agent");
                }
                candidates.push({ agentId, sessionId: result.entries[0].sessionId });
            }
            const outcomes = await Promise.all(
                candidates.map(async ({ agentId, sessionId }) => {
                    const requestId = `open-${agentId}`;
                    peer.send(
                        encodeNativeSessionCommand({
                            ...peer.base(agentId),
                            kind: NATIVE_SESSION_REQUEST_KIND,
                            requestId,
                            action,
                            sessionId,
                        }),
                    );
                    const frame = await peer.next(requestId, ["native.session.result", "session.operation.failed"]);
                    return { agentId, result: decodeDaemonToServiceMessage(frame) };
                }),
            );
            expect(outcomes.filter(({ result }) => result.kind === "native.session.result")).toHaveLength(2);
            for (const { agentId, result } of outcomes) {
                if (result.kind !== "native.session.result" || result.action !== action) {
                    throw new Error("Expected native open result");
                }
                expect(result.target.harness).toBe(agentId);
                await peer.prompt(result.target, `owner-continues-${agentId}`);
            }
        } finally {
            await peer.close();
        }
    },
);

test.for(["complete", "cancel"] as const)(
    "Given two browsers reading the same Agent, When their native requests overlap and the second is set to %s, Then each receives its own result without rejecting the concurrent reader",
    async (outcome, { signal }) => {
        const entered = Promise.withResolvers<void>();
        const barrier = new EventEmitter();
        let holdNext = false;
        const peer = await runtimePeer(signal, async (agent, resolveSignal) => {
            if (holdNext) {
                holdNext = false;
                const released = once(barrier, "continue", { signal: resolveSignal });
                entered.resolve();
                await released;
            }
            return agent;
        });
        const list = (requestId: string) => {
            peer.send(
                encodeNativeSessionCommand({
                    ...peer.base(),
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId,
                    action: "list",
                    cursor: null,
                }),
            );
            return peer.next(requestId, ["native.session.result", "session.operation.failed"]);
        };
        try {
            const seed = await peer.create();
            await peer.prompt(seed, "seed-history");
            holdNext = true;
            const first = list("first-list");
            await entered.promise;
            const second = list("second-list");
            if (outcome === "cancel") {
                peer.send(
                    encodeNativeSessionCancel({
                        kind: "native.session.cancel",
                        requestId: "second-list",
                    }),
                );
            }
            // The independent wire reply establishes that both requests reached the Runtime before release.
            peer.send(encodeSessionListCommand({ kind: "session.list", requestId: "received", limit: 1 }));
            await peer.next("received", ["session.listed"]);
            barrier.emit("continue");
            const original = decodeNativeSessionResult(await first);
            if (original.action !== "list" || original.entries[0] === undefined) {
                throw new Error("Expected the first browser's native history");
            }
            expect(decodeDaemonToServiceMessage(await second)).toMatchObject(
                outcome === "cancel"
                    ? { kind: "session.operation.failed", code: "native_session_cancelled", requestId: "second-list" }
                    : {
                          kind: "native.session.result",
                          action: "list",
                          requestId: "second-list",
                          entries: [{ sessionId: original.entries[0].sessionId }],
                      },
            );
            expect(decodeNativeSessionResult(await list("fresh-list"))).toMatchObject({
                action: "list",
                entries: [{ sessionId: original.entries[0].sessionId }],
            });
        } finally {
            barrier.emit("continue");
            await peer.close();
        }
    },
);

async function runtimePeer(signal: AbortSignal, resolveAgent?: RuntimeConfig["resolveAgent"]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-session-environment-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    const launches = join(directory, "launches.jsonl");
    const nativeRequests = join(directory, "native-requests.jsonl");
    const launcher = join(directory, "agent.mjs");
    const agentPeer = new URL("../sessions/fixtures/acp-peer.ts", import.meta.url).href;
    await Promise.all([mkdir(workspace), mkdir(harnessState), writeFile(launches, ""), writeFile(nativeRequests, "")]);
    await writeFile(
        launcher,
        `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const context = process.env.MORTY_TEST_SESSION_CONTEXT ?? null;
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ context }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (typeof request.method === "string" && /^(?:session|_session)\\//.test(request.method) && request.method !== "session/list") {
        appendFileSync(${JSON.stringify(nativeRequests)}, JSON.stringify({ context, method: request.method }) + "\\n");
    }
});
await import(${JSON.stringify(agentPeer)});
`,
    );
    const external = fakeAgentHarness({ id: "codex", label: "Controlled ACP" }, harnessState);
    const createAgent = (id: string) =>
        new AcpAgentDefinition(
            id,
            external.label,
            process.execPath,
            (options) =>
                new ControlledAcpConnection(
                    { id, adapterPath: process.execPath, arguments: [launcher], environment: options.environment },
                    options,
                ),
            external.environment,
            external.agentVersion,
            undefined,
            external.capabilities,
            external.adapterVersion,
        );
    const agent = createAgent("codex");
    const otherAgent = createAgent("other-codex");
    const relay = createServer((_request, response) => response.writeHead(204).end());
    const server = new WebSocketServer({ server: relay });
    const frames: string[] = [];
    const listeners = new Set<(frame: string) => void>();
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
        socket = connected;
        connected.on("message", (value) => {
            const frame = value.toString();
            if (frame === RUNTIME_HEARTBEAT_MESSAGE) {
                connected.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
            } else {
                frames.push(frame);
                for (const listener of listeners) {
                    listener(frame);
                }
            }
        });
        connected.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
    });
    const listening = once(relay, "listening", { signal });
    relay.listen(0, "127.0.0.1");
    await listening;
    const address = relay.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected the relay port");
    }
    const config = {
        ...createControlledRuntimeConfig(
            {
                credentials: memoryRuntimeCredentials("r".repeat(43)),
                computerId: "environment",
                defaultWorkspace: workspace,
                relayUrl: new URL(`ws://127.0.0.1:${address.port}/morty/api/v1/runtimes/connect`),
            },
            [agent, otherAgent],
            new RuntimeLocalContext(join(directory, "runtime"), process.env),
            null,
            resolveAgent,
        ),
        sessionEnvironment: (target: NativeSessionTarget) => ({
            MORTY_TEST_SESSION_CONTEXT: JSON.stringify(target),
        }),
    };
    let cancellation = new AbortController();
    const connected = once(server, "connection", { signal });
    let execution = runRuntime(config, cancellation.signal);
    await connected;
    const abort = () => cancellation.abort();
    signal.addEventListener("abort", abort, { once: true });
    const next = (requestId: string, kinds: readonly string[]): Promise<string> => {
        const matches = (frame: string): boolean => {
            const value: unknown = JSON.parse(frame);
            if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
                return false;
            }
            const addressed =
                ("requestId" in value && value.requestId === requestId) ||
                ("commandId" in value && value.commandId === requestId) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify(requestId)));
            if (!addressed) {
                return false;
            }
            if (value.kind.endsWith(".failed") && !kinds.includes(value.kind)) {
                throw new Error(frame);
            }
            return (
                kinds.includes(value.kind) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify("prompt.completed")))
            );
        };
        signal.throwIfAborted();
        const existing = frames.find(matches);
        if (existing !== undefined) {
            return Promise.resolve(existing);
        }
        return new Promise<string>((resolve, reject) => {
            const cleanup = () => {
                listeners.delete(receive);
                signal.removeEventListener("abort", cancelled);
            };
            const cancelled = () => {
                cleanup();
                reject(signal.reason);
            };
            const receive = (frame: string) => {
                try {
                    if (matches(frame)) {
                        cleanup();
                        resolve(frame);
                    }
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            };
            listeners.add(receive);
            signal.addEventListener("abort", cancelled, { once: true });
        });
    };
    const send = (frame: string) => {
        if (socket === undefined) {
            throw new Error("The Runtime has not connected");
        }
        socket.send(frame);
    };
    const binding = (agentId = "codex") => ({
        agentId,
        directory: ".",
    });
    const base = (agentId = "codex") => ({ ...binding(agentId) });
    const readContexts = async (path: string) =>
        (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const value: unknown = JSON.parse(line);
                if (
                    typeof value !== "object" ||
                    value === null ||
                    !("context" in value) ||
                    (value.context !== null && typeof value.context !== "string")
                ) {
                    throw new Error("Invalid child context report");
                }
                return { context: value.context };
            });
    return {
        agent,
        base,
        next,
        send,
        create: async () => {
            const requestId = crypto.randomUUID();
            send(
                encodeSessionCreateCommand({
                    ...binding(),
                    kind: "session.create",
                    requestId,
                    operationId: crypto.randomUUID(),
                    configurations: [],
                }),
            );
            return decodeSessionReadyEvent(await next(requestId, ["session.ready"])).target;
        },
        launches: () => readContexts(launches),
        crashNextNativeList: () => writeFile(join(harnessState, "crash-next-list"), ""),
        nativeRequests: () => readContexts(nativeRequests),
        prompt: async (target: NativeSessionTarget, commandId: string) => {
            send(
                encodeSessionPromptCommand({
                    ...binding(target.harness),
                    target,
                    kind: "session.prompt",
                    commandId,
                    disposition: SessionPromptDisposition.Append,
                    prompt: commandId,
                    attachments: [],
                }),
            );
            await next(commandId, ["prompt.completed"]);
        },
        restart: async (stateName: string) => {
            cancellation.abort();
            await execution;
            cancellation = new AbortController();
            const connected = once(server, "connection", { signal });
            execution = runRuntime(
                { ...config, localContext: new RuntimeLocalContext(join(directory, stateName), process.env) },
                cancellation.signal,
            );
            await connected;
        },
        close: async () => {
            signal.removeEventListener("abort", abort);
            cancellation.abort();
            await execution;
            for (const connection of server.clients) {
                connection.terminate();
            }
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        },
    };
}
