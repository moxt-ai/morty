import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import {
    decodeContentChunkFrame,
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    decodeSessionAccessCredential,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
    encodeContentAvailableEvent,
    encodeContentChunkFrame,
    encodeContentReadyEvent,
    encodeFileBeginEvent,
    encodeNativeSessionRequest,
    encodeNativeSessionResult,
    encodeSessionArchivedEvent,
    encodeSessionClosedEvent,
    encodeSessionConfigReadResult,
    encodeSessionConfigUpdatedEvent,
    encodeSessionConfigureCommand,
    encodeSessionEventEnvelope,
    encodeSessionHistoryPageLoaded,
    encodeSessionInfoUpdatedEvent,
    encodeSessionOperationFailedEvent,
    encodeSessionPreviewHistoryPageLoaded,
    encodeSessionPromptAcceptedEvent,
    encodeSessionPromptCommand,
    encodeSessionRenamedEvent,
    encodeSessionStatusChangedEvent,
    encodeSessionTurnStoppedEvent,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_SUCCESSOR_CREDENTIAL_HEADER,
    runtimeCredentialSuccessor,
    type SessionConfigReadResult,
} from "@morty-build/client/protocol";
import { DurableObjectSqlDatabase, RelaySockets, SessionControl } from "@morty-build/relay-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createTestMortyRelayApp } from "../../relay-test-support/src/app.ts";
import { requestTestRuntimeControl } from "../../relay-test-support/src/backend-fixture.ts";
import { ComputerRelay as RelayRuntimeRelay } from "../src/durable-objects/computer-relay.ts";
import { createRelayDurableObjectContext } from "../src/durable-objects/relay-durable-object-context.ts";
import { createRelayGateways, RelayAuthenticationConfiguration, type RelayRelayBindings } from "../src/worker.ts";
import { computerBackend, createOwner, issueSession, ownerRequest } from "./owner-fixture.ts";
import { computerManagementStore } from "./registered-runtime.ts";

const nativeTarget = (sessionId: string): NativeSessionTarget => ({ harness: "codex", sessionId });

function liveEvent(sessionTarget: NativeSessionTarget, text: string): string {
    return encodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                target: sessionTarget,
                type: "acp",
                payload: {
                    messageId: "message-1",
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                },
            },
        ],
    });
}

const relayOrigin = "https://relay.test";
const readyAgents = [
    {
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 1.0.0",
        capabilities: {
            audioPrompt: false,
            closeSession: true,
            deleteSession: true,
            embeddedContextPrompt: true,
            imagePrompt: true,
            listSessions: true,
            loadSession: true,
            promptQueueing: false,
            renameSession: false,
            resumeSession: true,
            steering: false,
            unstableForkSession: false,
        },
        harness: "codex",
        label: "Codex",
    },
];

/** Connects as a paired daemon does: each connection presents the credential and a successor that becomes current. */
class DaemonCredential {
    #current: string;

    constructor(credential: string) {
        this.#current = credential;
    }

    readonly connect = async (fetch: (request: Request) => Response | Promise<Response>): Promise<Response> => {
        const successor = runtimeCredentialSuccessor(this.#current);
        const response = await fetch(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/runtimes/connect`, {
                headers: {
                    authorization: `Bearer ${this.#current}`,
                    [RUNTIME_SUCCESSOR_CREDENTIAL_HEADER]: successor,
                    Upgrade: "websocket",
                },
            }),
        );
        if (response.status === 101) {
            this.#current = successor;
        }
        return response;
    };
}

function bindings(): RelayRelayBindings {
    return {
        RELAY_DIRECTORY_DATABASE: env.RELAY_DIRECTORY_DATABASE,
        COMPUTER_RELAY: env.COMPUTER_RELAY,
        MORTY_SESSION_SIGNING_SECRET: env.MORTY_SESSION_SIGNING_SECRET,
    };
}

type CredentialSigner = () => Promise<CryptoKey>;
async function relaySigningKey(signingSecret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(signingSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
}
const relaySigner: CredentialSigner = () => relaySigningKey(env.MORTY_SESSION_SIGNING_SECRET);
const storedDigestSigner: CredentialSigner = () => relaySigningKey("unrelated-credential-digest");

function credentialHeaders(credential: string): Headers {
    return new Headers({ authorization: `Bearer ${credential}`, "content-type": "application/json" });
}

class SocketMessages {
    readonly #messages: unknown[] = [];
    readonly #resolvers: Array<(message: unknown) => void> = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly nextFrame = (): Promise<unknown> => {
        const message = this.#messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.#resolvers.push(resolve))
            : Promise.resolve(message);
    };

    readonly next = async (): Promise<string> => {
        const message = await this.nextFrame();
        if (typeof message !== "string") {
            throw new Error("Expected a text WebSocket message");
        }
        return message;
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function text(value: Readonly<Record<string, unknown>>, name: string): string {
    const field = value[name];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return field;
}

async function responseJson(response: Response, expectedStatus: number): Promise<Readonly<Record<string, unknown>>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    return record(body);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

afterAll(async () => {
    await abortAllDurableObjects();
});

describe.sequential("Relay Session-only boundary", () => {
    it("Given an allowed Chat origin, When the browser preflights a Session file read, Then Relay permits the request", async () => {
        const browserOrigin = "https://chat.test";
        const worker = createTestMortyRelayApp(
            new RelayAuthenticationConfiguration(new Set([browserOrigin])),
            createRelayGateways,
        );
        const computerId = "prj_ap_01_abcdefghijklmnopqrstuvwx";

        const response = await worker.fetch(
            new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/local-session/files/content?maxBytes=33554432&path=%2Fworkspace%2Fpackage.json`,
                {
                    headers: {
                        "access-control-request-headers": "authorization",
                        "access-control-request-method": "GET",
                        origin: browserOrigin,
                    },
                    method: "OPTIONS",
                },
            ),
            bindings(),
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    });

    it("Given a Session route the Relay no longer serves, When an app requests pending interactions, Then the Relay answers with a typed JSON not_found error", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const computerId = "prj_ap_01_abcdefghijklmnopqrstuvwx";

        const response = await worker.fetch(
            new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/local-session/interactions`,
                { headers: { authorization: "Bearer app_credential" } },
            ),
            bindings(),
        );

        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("Given a linked Codex Runtime with required empty installation metadata, When Chat imports, forks, configures and prompts Sessions across Relay hibernation, Then results, answers and connection status arrive without cloud Session storage", async () => {
        vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "private-reconnect-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const redemptionUrl = `${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`;
        const claimed = await responseJson(
            await worker.fetch(
                new Request(redemptionUrl, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        machineName: "Private reconnect Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "private-reconnect-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        expect(claimed).not.toHaveProperty("appId");
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({
            agents: [{ harness: "codex", label: "Codex" }],
            computerId,
        });
        const sessionId = "local-codex-session";
        const daemonCredential = new DaemonCredential(text(claimed, "runtimeCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        expect(daemonResponse.status).toBe(101);
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected a daemon socket");
        }
        const daemon = daemonResponse.webSocket;
        const host = await backend.openHost(new AbortController().signal);
        const daemonMessages = new SocketMessages(daemon);
        const hostMessages = new SocketMessages(host);
        daemon.accept();
        host.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            const rollback = {
                kind: "runtime.upgrade.result",
                requestId: "local-npm-upgrade",
                version: "0.0.227",
                targetVersion: "0.0.228",
                outcome: {
                    status: "failed",
                    code: "worker_exited",
                    message: "The new daemon exited before becoming ready",
                    retryAfter: 3600000,
                },
            };
            daemon.send(JSON.stringify(rollback));
            expect(JSON.parse(await hostMessages.next())).toEqual(rollback);
            const closeResponse = requestTestRuntimeControl(
                env,
                computerId,
                { kind: "session.close", requestId: crypto.randomUUID(), target: nativeTarget("session-to-close") },
                AbortSignal.timeout(10000),
            );
            const closeCommand = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(closeCommand).toMatchObject({
                kind: "session.close",
                target: nativeTarget("session-to-close"),
            });
            if (closeCommand.kind !== "session.close") {
                throw new Error("Expected a Session close command");
            }
            expect(decodeServiceToDaemonMessage(await hostMessages.next())).toMatchObject(closeCommand);
            daemon.send(
                encodeSessionClosedEvent({
                    kind: "session.closed",
                    requestId: closeCommand.requestId,
                    target: nativeTarget("session-to-close"),
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                kind: "session.closed",
                requestId: closeCommand.requestId,
                target: nativeTarget("session-to-close"),
            });
            expect(await closeResponse).toEqual({
                kind: "session.closed",
                requestId: closeCommand.requestId,
                target: nativeTarget("session-to-close"),
            });
            const archiveResponse = requestTestRuntimeControl(
                env,
                computerId,
                { kind: "session.archive", requestId: crypto.randomUUID(), target: nativeTarget("session-to-close") },
                AbortSignal.timeout(10000),
            );
            const archiveCommand = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (archiveCommand.kind !== "session.archive") {
                throw new Error("Expected a Session archive command");
            }
            expect(archiveCommand.target).toEqual(nativeTarget("session-to-close"));
            expect(decodeServiceToDaemonMessage(await hostMessages.next())).toMatchObject(archiveCommand);
            const archived = {
                kind: "session.archived",
                requestId: archiveCommand.requestId,
                target: nativeTarget("session-to-close"),
            } as const;
            daemon.send(encodeSessionArchivedEvent(archived));
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual(archived);
            expect(await archiveResponse).toEqual(archived);
            // Native HTTP probes use request-reply connections, while this viewer keeps its live subscription.
            for (const outcome of ["idle", "busy"] as const) {
                const activeTurnResponse = new SessionControl(
                    (command) => requestTestRuntimeControl(env, computerId, command, AbortSignal.timeout(10000)),
                    nativeTarget(sessionId),
                ).activeTurn();
                const query = decodeServiceToDaemonMessage(await daemonMessages.next());
                if (query.kind !== "native.session.request" || query.action !== "active-turn") {
                    throw new Error("Expected the HTTP active Turn query to reach the daemon");
                }
                expect(decodeServiceToDaemonMessage(await hostMessages.next())).toMatchObject(query);
                const reply =
                    outcome === "idle"
                        ? encodeNativeSessionResult({
                              kind: "native.session.result",
                              action: "active-turn",
                              requestId: query.requestId,
                              target: nativeTarget(sessionId),
                              turn: null,
                              queued: [],
                              queuedCancellation: "before-start",
                              executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                              interactionState: null,
                          })
                        : encodeSessionOperationFailedEvent({
                              kind: "session.operation.failed",
                              requestId: query.requestId,
                              target: nativeTarget(sessionId),
                              code: "native_session_busy",
                              message: "Another native session operation is running",
                          });
                daemon.send(reply);
                expect(JSON.parse(await hostMessages.next())).toMatchObject({ requestId: query.requestId });
                if (outcome === "idle") {
                    expect(await activeTurnResponse).toMatchObject({ action: "active-turn", turn: null, queued: [] });
                } else {
                    await expect(activeTurnResponse).rejects.toMatchObject({ code: "native_session_busy" });
                }
            }
            // A Host can multiplex discovery, but routing must remain bounded and reject overload explicitly.
            const discoveryRequests = Array.from({ length: 4 }, (_, index) => ({
                kind: "agent.settings.discover",
                harness: "a".repeat(128),
                requestId: `settings-${index}`.padEnd(128, "r"),
            }));
            const hostClosed = Promise.withResolvers<{ readonly kind: "host.closed"; readonly code: number }>();
            host.addEventListener("close", (event) => hostClosed.resolve({ kind: "host.closed", code: event.code }), {
                once: true,
            });
            for (const request of discoveryRequests) {
                host.send(JSON.stringify(request));
                expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject(request);
            }
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    harness: "a".repeat(128),
                    requestId: "settings-overflow",
                }),
            );
            host.send(JSON.stringify({ kind: "runtime.ping", requestId: "settings-capacity-barrier" }));
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "runtime.ping",
                requestId: "settings-capacity-barrier",
            });
            expect(
                await Promise.race([hostMessages.next().then((message) => JSON.parse(message)), hostClosed.promise]),
            ).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-overflow",
                code: "agent_settings_discovery_busy",
            });
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("runtime.ping");
            for (const request of discoveryRequests) {
                daemon.send(
                    JSON.stringify({
                        kind: "agent.settings.discovery.failed",
                        requestId: request.requestId,
                        code: "probe_failed",
                        message: "Controlled discovery failure",
                    }),
                );
                expect(JSON.parse(await hostMessages.next())).toMatchObject({
                    kind: "agent.settings.discovery.failed",
                    requestId: request.requestId,
                });
            }
            // Native imports and forks share this Runtime transport with configuration and live output.
            const closed = Promise.withResolvers<{ readonly kind: "closed"; readonly code: number }>();
            daemon.addEventListener("close", (event) => closed.resolve({ kind: "closed", code: event.code }), {
                once: true,
            });
            for (const action of ["import", "fork"] as const) {
                const requestId = `native-${action}-request`;
                const directory = action === "fork" ? `root-${"d".repeat(2000)}` : "root";
                host.send(
                    encodeNativeSessionRequest({
                        action,
                        harness: "codex",
                        directory,
                        sessionId: "native-entry",
                        kind: "native.session.request",
                        requestId,
                    }),
                );
                expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("native.session.request");
                expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("native.session.request");
            }
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    harness: "codex",
                    requestId: "settings-before-wake",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-wake",
            });
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    harness: "codex",
                    requestId: "settings-before-wake",
                }),
            );
            host.send(JSON.stringify({ kind: "runtime.ping", requestId: "settings-duplicate-barrier" }));
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "runtime.ping",
                requestId: "settings-duplicate-barrier",
            });
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("runtime.ping");
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerId), { webSockets: "hibernate" });
            for (const action of ["import", "fork"] as const) {
                const requestId = `native-${action}-request`;
                const directory = action === "fork" ? `root-${"d".repeat(2000)}` : "root";
                const sessionTarget = nativeTarget(
                    action === "import" ? "original-native-session" : "forked-native-session",
                );
                const capabilities = readyAgents[0]?.capabilities;
                if (capabilities === undefined) {
                    throw new Error("Expected the connected Agent capabilities");
                }
                const result = encodeNativeSessionResult({
                    action,
                    kind: "native.session.result",
                    requestId,
                    target: sessionTarget,
                    title: "Imported native session",
                    ready: {
                        harness: "codex",
                        agentName: "Codex",
                        agentVersion: "1.0.0",
                        capabilities,
                        commands: [],
                        configOptions: [],
                        configurationRevision: "revision-1",
                        directory: directory,
                        directoryLabel: "Workspace",
                        kind: "session.ready",
                        requestId,
                        restored: true,
                        target: sessionTarget,
                    },
                });
                daemon.send(result);
                const received = await Promise.race([
                    hostMessages.next().then((message) => decodeDaemonToServiceMessage(message)),
                    closed.promise,
                ]);
                expect(received).toMatchObject({
                    kind: "native.session.result",
                    action,
                    requestId,
                    target: sessionTarget,
                });
                expect(daemon.readyState).toBe(WebSocket.OPEN);
                // The caller owns operation expiry and duplicate handling.
                vi.setSystemTime(new Date("2030-01-01T00:06:00.000Z"));
                daemon.send(result);
                expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                    kind: "native.session.result",
                    action,
                    requestId,
                    target: sessionTarget,
                });
                expect(daemon.readyState).toBe(WebSocket.OPEN);
            }
            vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));

            vi.setSystemTime(new Date("2030-01-01T00:03:00.000Z"));
            daemon.send(
                JSON.stringify({
                    kind: "agent.settings.discovery.failed",
                    requestId: "settings-before-wake",
                    code: "probe_failed",
                    message: "Controlled discovery failure",
                }),
            );
            // Runtime and Session lanes can overtake each other. Keep this barrier
            // on the settings response's Runtime lane to detect a dropped route.
            const settingsBarrier = { ...rollback, requestId: "settings-response-barrier" };
            daemon.send(JSON.stringify(settingsBarrier));
            expect(JSON.parse(await hostMessages.next())).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-before-wake",
                code: "probe_failed",
            });
            expect(JSON.parse(await hostMessages.next())).toEqual(settingsBarrier);
            vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
            // Unknown Runtime output keeps its explicit Session route and payload.
            daemon.send(
                JSON.stringify({ kind: "session.future.changed", target: nativeTarget(sessionId), value: "future" }),
            );
            expect(JSON.parse(await hostMessages.next())).toEqual({
                kind: "session.future.changed",
                target: nativeTarget(sessionId),
                value: "future",
            });
            // Unknown client commands still cannot bypass Relay authorization.
            host.send(
                JSON.stringify({ kind: "session.future.request", target: nativeTarget(sessionId), value: "future" }),
            );
            host.send(
                encodeSessionConfigureCommand({
                    booleanValue: false,
                    configId: "model",
                    expectedConfigurationRevision: "configuration-revision",
                    kind: "session.configure",
                    requestId: "local-config-request",
                    target: nativeTarget(sessionId),
                    value: "model-deepseek-v4.1-flash",
                    valueType: "select",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.configure");
            expect(decodeServiceToDaemonMessage(await hostMessages.next()).kind).toBe("session.configure");
            daemon.send(
                encodeSessionConfigUpdatedEvent({
                    configOptions: [],
                    configurationRevision: "revision-1",
                    kind: "session.config.updated",
                    requestId: "local-config-request",
                    target: nativeTarget(sessionId),
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                configOptions: [],
                configurationRevision: "revision-1",
                kind: "session.config.updated",
                requestId: "local-config-request",
                target: nativeTarget(sessionId),
            });
            host.send(
                encodeSessionPromptCommand({
                    commandId: "local-codex-command",
                    disposition: "append",
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "show the local answer",
                    target: nativeTarget(sessionId),
                }),
            );
            const prompt = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(prompt.kind).toBe("session.prompt");
            if (prompt.kind !== "session.prompt") {
                throw new Error("Expected the prompt to reach the local Runtime");
            }
            expect(decodeSessionPromptCommand(JSON.stringify(prompt)).prompt).toBe("show the local answer");
            const answer = liveEvent(nativeTarget(sessionId), "local answer");
            daemon.send(answer);
            const received = decodeSessionEventEnvelope(await hostMessages.next());
            expect(JSON.stringify(received.events.map((event) => event.payload))).toContain("local answer");
            expect(received).not.toHaveProperty("cursor");
            expect(received).not.toHaveProperty("sequence");
            // Relay broadcasts the original V2 identity unchanged, including duplicate frames.
            daemon.send(answer);
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("local answer");

            const browserAccess = await issueSession(computerId, nativeTarget(sessionId));
            const v2Response = await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2`,
                    {
                        headers: {
                            authorization: `Bearer ${text(browserAccess, "credential")}`,
                            Upgrade: "websocket",
                        },
                    },
                ),
                environment,
            );
            expect(v2Response.status).toBe(101);
            if (v2Response.webSocket === null) {
                throw new Error("Expected the V2 Session event socket");
            }
            const v2Socket = v2Response.webSocket;
            const v2Messages = new SocketMessages(v2Socket);
            v2Socket.accept();
            const rawEvent = {
                eventId: "event-v2-1",
                payload: {
                    content: { text: "raw local answer", type: "text" as const },
                    messageId: "message-v2-1",
                    sessionUpdate: "agent_message_chunk" as const,
                },
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                target: nativeTarget(sessionId),
                type: "acp" as const,
            };
            const historicalEvent = {
                eventId: rawEvent.eventId,
                payload: rawEvent.payload,
                recordedAt: rawEvent.recordedAt,
                sessionGenerationId: rawEvent.sessionGenerationId,
                target: rawEvent.target,
                type: rawEvent.type,
            };
            const secondRawEvent = { ...rawEvent, eventId: "event-v2-2", position: "2" };
            daemon.send(encodeSessionEventEnvelope({ events: [rawEvent, secondRawEvent], kind: "session.event.v2" }));
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "session.event.v2" });
            expect(JSON.parse(await v2Messages.next())).toEqual([rawEvent, secondRawEvent]);
            const futureEvent = {
                ...rawEvent,
                eventId: "event-v2-future",
                position: "3",
                futureField: "retained",
                payload: {
                    ...rawEvent.payload,
                    content: { type: "future_content", text: "Future public output", extra: { retained: true } },
                },
            };
            daemon.send(JSON.stringify({ kind: "session.event.v2", events: [futureEvent] }));
            expect(JSON.parse(await hostMessages.next())).toEqual({ kind: "session.event.v2", events: [futureEvent] });
            expect(JSON.parse(await v2Messages.next())).toEqual([futureEvent]);
            const historyResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2?limit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const historyLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (historyLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected history loading without a preceding Session query");
            }

            daemon.send(
                encodeSessionStatusChangedEvent({
                    kind: "session.status.changed",
                    target: nativeTarget(sessionId),
                    status: { commandId: "command-1", kind: "working" },
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                kind: "session.status.changed",
                target: nativeTarget(sessionId),
                status: { commandId: "command-1", kind: "working" },
            });
            daemon.send(
                encodeSessionInfoUpdatedEvent({
                    kind: "session.info.updated",
                    target: nativeTarget(sessionId),
                    title: "Renamed session",
                    updatedAt: "2026-09-18T00:01:00.000Z",
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toEqual({
                kind: "session.info.updated",
                computerId,
                target: nativeTarget(sessionId),
                title: "Renamed session",
                updatedAt: "2026-09-18T00:01:00.000Z",
            });
            const historyPage = JSON.stringify({
                events: {
                    events: {
                        sessionGenerationId: "session-generation-1",
                        events: [futureEvent, historicalEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        throughPosition: "1",
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
                kind: "session.live-history.v2.page.loaded",
                requestId: historyLoad.requestId,
                target: nativeTarget(sessionId),
            });
            daemon.send(historyPage);
            expect(await responseJson(await historyResponse, 200)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [futureEvent, historicalEvent],
                nextCursor: null,
                tailCursor: rawEvent.eventId,
                throughPosition: "1",
                truncated: false,
                version: 2,
            });
            // Direct Runtime HTTP owns the response until it completes; hibernate between requests.
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerId), { webSockets: "hibernate" });
            // A delayed result after the caller has finished must not disconnect the Runtime.
            daemon.send(historyPage);
            const previewHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/native-events-preview?directory=root&eventLimit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const previewHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (previewHistoryLoad.kind !== "session.preview-history.page.load") {
                throw new Error("Expected a native Session preview history request");
            }

            const previewHistoryPage = encodeSessionPreviewHistoryPageLoaded({
                events: {
                    events: {
                        sessionGenerationId: "native-session-generation-1",
                        events: [rawEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        throughPosition: "1",
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
                kind: "session.preview-history.page.loaded",
                requestId: previewHistoryLoad.requestId,
                target: nativeTarget(sessionId),
            });
            daemon.send(previewHistoryPage);
            expect(await responseJson(await previewHistoryResponse, 200)).toEqual({
                events: {
                    sessionGenerationId: "native-session-generation-1",
                    events: [historicalEvent],
                    nextCursor: null,
                    tailCursor: rawEvent.eventId,
                    throughPosition: "1",
                    truncated: false,
                    version: 2,
                },
                queuedPromptRequests: [],
            });
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerId), { webSockets: "hibernate" });
            // A delayed result after the caller has finished must not disconnect the Runtime.
            daemon.send(previewHistoryPage);
            const failedPreviewHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/native-events-preview?directory=root&eventLimit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const failedPreviewHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (failedPreviewHistoryLoad.kind !== "session.preview-history.page.load") {
                throw new Error("Expected a native Session preview history request");
            }
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "native_history_unavailable",
                    kind: "session.operation.failed",
                    message: "The Codex thread is not loaded",
                    requestId: failedPreviewHistoryLoad.requestId,
                    target: nativeTarget(sessionId),
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                code: "native_history_unavailable",
                kind: "session.operation.failed",
                message: "The Codex thread is not loaded",
                requestId: failedPreviewHistoryLoad.requestId,
            });
            expect(await responseJson(await failedPreviewHistoryResponse, 503)).toEqual({
                error: {
                    code: "native_history_unavailable",
                    message: "The Codex thread is not loaded",
                },
            });
            // A Runtime that closed the Session refuses to load its history. The refusal is a typed conflict, so a
            // client can offer to reopen the Session instead of retrying the load.
            const closedHistoryResponse = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2?limit=50`,
                    { headers: { authorization: `Bearer ${text(browserAccess, "credential")}` } },
                ),
                environment,
            );
            const closedHistoryLoad = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (closedHistoryLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a live Session history request");
            }
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "session_closed",
                    kind: "session.operation.failed",
                    message: "The Session is closed",
                    requestId: closedHistoryLoad.requestId,
                    target: nativeTarget(sessionId),
                }),
            );
            expect(decodeDaemonToServiceMessage(await hostMessages.next())).toMatchObject({
                code: "session_closed",
                kind: "session.operation.failed",
                requestId: closedHistoryLoad.requestId,
            });
            expect(await responseJson(await closedHistoryResponse, 409)).toEqual({
                error: { code: "session_closed", message: "The Session is closed" },
            });
            v2Socket.close(1000, "V2 browser test complete");
            const transportResponse = await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
                environment,
            );
            expect(transportResponse.status).toBe(101);
            if (transportResponse.webSocket === null) {
                throw new Error("Expected the browser transport socket");
            }
            const transport = transportResponse.webSocket;
            const transportMessages = new SocketMessages(transport);
            transport.accept();
            transport.send(
                JSON.stringify({
                    headers: [["authorization", `Bearer ${text(browserAccess, "credential")}`]],
                    kind: "session.events.subscribe",
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2`,
                    subscriptionId: "subscription-1",
                }),
            );
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                kind: "session.events.ready",
                subscriptionId: "subscription-1",
            });
            const otherBrowser = (
                await worker.fetch(
                    new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                        headers: { Upgrade: "websocket" },
                    }),
                    environment,
                )
            ).webSocket;
            if (otherBrowser === null) {
                throw new Error("Expected a second browser transport");
            }
            const otherMessages = new SocketMessages(otherBrowser);
            otherBrowser.accept();
            otherBrowser.send(
                JSON.stringify({
                    headers: [["authorization", `Bearer ${text(browserAccess, "credential")}`]],
                    kind: "session.events.subscribe",
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2`,
                    subscriptionId: "subscription-2",
                }),
            );
            expect(JSON.parse(await otherMessages.next())).toMatchObject({ kind: "session.events.ready" });
            transport.send("invalid-json");
            expect(JSON.parse(await transportMessages.next())).toMatchObject({ kind: "http.error" });
            transport.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "runtime-agents",
                    method: "GET",
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/daemon/agents`,
                    headers: [["authorization", `Bearer ${appCredential}`]],
                    body: "",
                }),
            );
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                kind: "http.response",
                requestId: "runtime-agents",
                status: 404,
            });
            daemon.send(answer);
            expect(
                JSON.stringify(
                    decodeSessionEventEnvelope(await hostMessages.next()).events.map((event) => event.payload),
                ),
            ).toContain("local answer");
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                data: expect.stringContaining("local answer"),
                eventId: "",
                kind: "session.events.event",
                seqId: 1,
                subscriptionId: "subscription-1",
            });
            expect(JSON.parse(await otherMessages.next())).toMatchObject({
                kind: "session.events.event",
                subscriptionId: "subscription-2",
                data: expect.stringContaining("local answer"),
            });
            transport.close(1000, "Browser test complete");
            otherBrowser.send('{"kind":"ping"}');
            expect(await otherMessages.next()).toBe('{"kind":"pong"}');
            otherBrowser.close(1000, "Other browser complete");
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    harness: "codex",
                    requestId: "settings-before-disconnect",
                }),
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-disconnect",
            });
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerId), { webSockets: "hibernate" });
            daemon.close(1000, "Reconnect Runtime");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({
                kind: "agent.settings.discovery.failed",
                requestId: "settings-before-disconnect",
                code: "runtime_offline",
            });
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: false });
            const reconnectResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
            expect(reconnectResponse.status).toBe(101);
            if (reconnectResponse.webSocket === null) {
                throw new Error("Expected the reconnected Runtime socket");
            }
            const reconnected = reconnectResponse.webSocket;
            const reconnectMessages = new SocketMessages(reconnected);
            reconnected.accept();
            expect(decodeServiceToDaemonMessage(await reconnectMessages.next()).kind).toBe("runtime.liveness.ready");
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            host.send(
                JSON.stringify({
                    kind: "agent.settings.discover",
                    harness: "codex",
                    requestId: "settings-before-replacement",
                }),
            );
            expect(decodeServiceToDaemonMessage(await reconnectMessages.next())).toMatchObject({
                kind: "agent.settings.discover",
                requestId: "settings-before-replacement",
            });
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerId), { webSockets: "hibernate" });
            const replacementResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
            expect(replacementResponse.status).toBe(101);
            if (replacementResponse.webSocket === null) {
                throw new Error("Expected the replacement Runtime socket");
            }
            const replacement = replacementResponse.webSocket;
            const replacementMessages = new SocketMessages(replacement);
            replacement.accept();
            try {
                expect(decodeServiceToDaemonMessage(await replacementMessages.next()).kind).toBe(
                    "runtime.liveness.ready",
                );
                expect(JSON.parse(await hostMessages.next())).toMatchObject({
                    kind: "agent.settings.discovery.failed",
                    requestId: "settings-before-replacement",
                    code: "runtime_offline",
                });
                expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: true });
            } finally {
                replacement.close(1000, "Test complete");
            }
            expect(JSON.parse(await hostMessages.next())).toMatchObject({ kind: "runtime.status", online: false });
            await runInDurableObject(environment.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
                const sessionTables = [
                    ...state.storage.sql.exec<{ name: string }>(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_bindings', 'session_configuration_snapshots', 'turns', 'attempts', 'interactions', 'pending_work', 'command_receipts', 'session_event_receipts', 'reliable_event_receipts', 'runtime_active_sessions', 'runtime_disconnect')",
                    ),
                ];
                expect(sessionTables).toEqual([]);
            });
            const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
            const liveTarget = await responseJson(
                await worker.fetch(
                    new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/live-event-subscription-target`,
                        { headers: credentialHeaders(text(sessionAccess, "credential")) },
                    ),
                    environment,
                ),
                200,
            );
            // The answer has a public shape; it names no AppCredential.
            expect(liveTarget).toStrictEqual({
                expiresAtEpochMilliseconds: expect.any(Number),
                issuedAtEpochMilliseconds: expect.any(Number),
                kind: "expiring",
                computerId,
            });
        } finally {
            daemon.close(1000, "Test complete");
            host.close(1000, "Test complete");
        }
    }, 180_000);

    it("Given a machine with no discovered local Agent, When it redeems a Runtime pairing and publishes its catalog, Then pairing succeeds and the Runtime advertises an empty Agent directory", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "unattended-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`, {
                    body: JSON.stringify({
                        agents: [],
                        futureClientField: "unknown keys are tolerated",
                        machineName: "Unattended Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "unattended-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        const runtimeCredential = text(claimed, "runtimeCredential");

        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({ agents: [], computerId });

        const catalogUpdate = await worker.fetch(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/channels/${text(claimed, "computerId")}/catalog`, {
                body: JSON.stringify({ agents: [], "ignored keys are tolerated": true }),
                headers: { authorization: `Bearer ${runtimeCredential}`, "content-type": "application/json" },
                method: "PUT",
            }),
            environment,
        );
        expect(catalogUpdate.status).toBe(204);
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({ agents: [], computerId });
    });
});

/**
 * Pairs a Runtime, connects its daemon with liveness, and grants Chat access to one Session.
 *
 * Cloudflare stamps heartbeat answers with its own clock, which fake timers cannot move. With
 * `anchorClockToHeartbeat`, the daemon heartbeats once and the fake clock is set to that answer
 * before the Session credential is issued, so later times are explicit offsets from it.
 */
async function connectRuntimeDaemon(slug: string, options: { readonly anchorClockToHeartbeat?: boolean } = {}) {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
    const environment = bindings();
    const owner = await createOwner();
    const { computerId } = owner;
    const appCredential = owner.token;
    const backend = computerBackend(computerId);
    const pairComputer = async (idempotencyKey: string) => {
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        machineName: `${slug} Runtime`,
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: `${slug}-workspace`,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        return new DaemonCredential(text(claimed, "runtimeCredential"));
    };
    const sessionId = `${slug}-session`;
    const daemonCredential = await pairComputer(`${slug}-runtime`);
    const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
    if (daemonResponse.webSocket === null) {
        throw new Error("Expected the Runtime socket");
    }
    const daemon = daemonResponse.webSocket;
    const daemonMessages = new SocketMessages(daemon);
    const daemonClosed = new Promise<CloseEvent>((resolve) => {
        daemon.addEventListener("close", resolve, { once: true });
    });
    daemon.accept();
    expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
    /** Heartbeats exactly as the daemon does and returns when Cloudflare answered, by its own clock. */
    const heartbeat = async (): Promise<number> => {
        daemon.send(RUNTIME_HEARTBEAT_MESSAGE);
        expect(await daemonMessages.next()).toBe(RUNTIME_HEARTBEAT_ACK_MESSAGE);
        return await runInDurableObject(environment.COMPUTER_RELAY.getByName(computerId), (_instance, state) => {
            const socket = state.getWebSockets("daemon")[0];
            const answeredAt = socket === undefined ? null : state.getWebSocketAutoResponseTimestamp(socket);
            if (answeredAt === null) {
                throw new Error("Expected Cloudflare to have answered the heartbeat");
            }
            return answeredAt.getTime();
        });
    };
    if (options.anchorClockToHeartbeat === true) {
        vi.setSystemTime(await heartbeat());
    }
    const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
    return {
        credential: text(sessionAccess, "credential"),
        transport: () =>
            worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
                environment,
            ),
        computerId,
        sessionTarget: nativeTarget(sessionId),
        revoke: async () => {
            await backend.revokeRuntime(AbortSignal.timeout(10000));
            return new Response(null, { status: 204 });
        },
        reconnect: () => daemonCredential.connect((request) => worker.fetch(request, environment)),
        pairAgain: pairComputer,
        connect: (credential: DaemonCredential) => credential.connect((request) => worker.fetch(request, environment)),
        subscribe: () =>
            worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events-v2`,
                    {
                        headers: { authorization: `Bearer ${text(sessionAccess, "credential")}`, Upgrade: "websocket" },
                    },
                ),
                environment,
            ),
        forkNative: (operationId: string, input: ForkMortyNativeSessionRequest) =>
            ownerRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/chat/computers/${computerId}/native-session-forks/${operationId}`,
                    {
                        method: "POST",
                        headers: credentialHeaders(appCredential),
                        body: JSON.stringify({ ...input, computerId }),
                    },
                ),
            ),
        appSessionRequest: async (
            path: string,
            init: {
                readonly method: string;
                readonly body?: unknown;
                readonly credential?: string;
                readonly computerId?: string;
            },
        ) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${init.computerId ?? computerId}/harnesses/codex/sessions/${sessionId}${path}`,
                    {
                        method: init.method,
                        headers: credentialHeaders(init.credential ?? sessionAccess.credential),
                        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                    },
                ),
                environment,
            ),
        sessionControlRequest: async (path: string, body: unknown, credential = text(sessionAccess, "credential")) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}${path}`,
                    {
                        method: "POST",
                        headers: credentialHeaders(credential),
                        body: JSON.stringify(body),
                    },
                ),
                environment,
            ),
        uploadContent: async (
            contentKey: string,
            bytes: Uint8Array,
            metadata: {
                readonly kind: "image" | "resource";
                readonly mediaType: string;
                readonly name: string;
                readonly uri: string;
            },
        ) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/content/${contentKey}?${new URLSearchParams({ uri: metadata.uri }).toString()}`,
                    {
                        body: bytes,
                        headers: {
                            authorization: `Bearer ${text(sessionAccess, "credential")}`,
                            "content-type": metadata.mediaType,
                            "x-morty-byte-length": String(bytes.byteLength),
                            "x-morty-content-kind": metadata.kind,
                            "x-morty-file-name": encodeURIComponent(metadata.name),
                        },
                        method: "PUT",
                    },
                ),
                environment,
            ),
        /** Signs the issued claims again, optionally with another lifetime, under the key `signer` derives. */
        resignCredential: async (signer: CredentialSigner, lifetimeMilliseconds?: number) => {
            // Sign adversarial claims outside the Relay issuer, which refuses invalid lifetimes.
            const decoded = decodeSessionAccessCredential(text(sessionAccess, "credential"));
            const claims =
                lifetimeMilliseconds === undefined
                    ? decoded.claims
                    : {
                          ...decoded.claims,
                          expiresAtEpochMilliseconds: decoded.claims.issuedAtEpochMilliseconds + lifetimeMilliseconds,
                      };
            const encode = (bytes: Uint8Array) =>
                btoa(String.fromCharCode(...bytes))
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/u, "");
            const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
            const signedValue = `msession_${payload}`;
            const key = await signer();
            const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedValue));
            return `${signedValue}.${encode(new Uint8Array(signature))}`;
        },
        daemon,
        daemonClosed,
        daemonMessages,
        heartbeat,
        readOnline: async () => (await backend.agents(AbortSignal.timeout(10000)))["online"],
        /** Starts the submitted Turn: the Runtime records its start and answers the submission as running. */
        startTurn: (commandId: string, position: string) => {
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `${commandId}-started`,
                            position,
                            recordedAt: new Date().toISOString(),
                            sessionGenerationId: "session-generation-1",
                            target: nativeTarget(sessionId),
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: `${commandId}-attempt`,
                                commandId,
                                epoch: `${slug}-epoch`,
                                kind: "prompt.started",
                            },
                        },
                    ],
                }),
            );
            daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: commandId,
                    target: nativeTarget(sessionId),
                    state: "running",
                }),
            );
        },
        issueRuntimeCredential: async (_targetComputerId: string) =>
            (await issueSession(computerId, nativeTarget(sessionId))).credential,
        queryActiveTurn: async (signal: AbortSignal) =>
            worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/active-turn`,
                    {
                        method: "GET",
                        headers: credentialHeaders(sessionAccess.credential),
                        signal,
                    },
                ),
                environment,
            ),
        readFile: async (path: string) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/files/content?${new URLSearchParams({ maxBytes: "1024", path }).toString()}`,
                    { headers: credentialHeaders(text(sessionAccess, "credential")) },
                ),
                environment,
            ),
        submitRuntimeTurn: (
            idempotencyKey: string,
            credentialTransform: (credential: string) => string = (credential) => credential,
            requestedSessionId: string = sessionId,
            destinationComputerId: string = computerId,
        ) =>
            env.COMPUTER_RELAY.getByName(destinationComputerId).fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${requestedSessionId}/turns`,
                    {
                        method: "POST",
                        headers: credentialHeaders(credentialTransform(text(sessionAccess, "credential"))),
                        body: JSON.stringify({
                            content: "Direct execution",
                            idempotencyKey,
                            attachments: [],
                        }),
                    },
                ),
            ),
        readSessionExecution: (commandId?: string) =>
            env.COMPUTER_RELAY.getByName(computerId).fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/active-turn?${new URLSearchParams(
                        commandId === undefined ? {} : { commandId },
                    ).toString()}`,
                    { headers: credentialHeaders(text(sessionAccess, "credential")) },
                ),
            ),
        submitTurn: (idempotencyKey: string) =>
            worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                    {
                        body: JSON.stringify({
                            content: `Run ${idempotencyKey}`,
                            idempotencyKey,
                            attachments: [],
                        }),
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
                environment,
            ),
    };
}

it.each(["text", "binary"])(
    "Given a connected Runtime, When revocation commits but disconnect delivery fails and a %s message arrives, Then later events reach no viewer and the daemon is closed",
    async (format) => {
        const runtime = await connectRuntimeDaemon(`revoked-stream-${format}`);
        const response = await runtime.subscribe();
        expect(response.status).toBe(101);
        const viewer = response.webSocket;
        if (viewer === null) {
            throw new Error("Expected a Session event subscription");
        }
        const messages = new SocketMessages(viewer);
        const received: string[] = [];
        viewer.addEventListener("message", (event) => {
            received.push(String(event.data));
        });
        viewer.accept();
        const deliver = (message: string | Uint8Array) =>
            runInDurableObject(env.COMPUTER_RELAY.getByName(runtime.computerId), async (_instance, state) => {
                const pending: Promise<void>[] = [];
                const database = new DurableObjectSqlDatabase(state.storage);
                const context = createRelayDurableObjectContext(state, bindings(), {
                    database,
                    storeFor: (computerId) => computerManagementStore(computerId, state.storage),
                });
                const relay = new RelaySockets(
                    createDurableObjectDependencies({
                        doDatabase: database,
                        storages: context.storages,
                        gateways: context.gateways,
                        utilities: {
                            waitUntil: (operation) => {
                                pending.push(operation);
                            },
                        },
                    }),
                );
                const daemon = state.getWebSockets("daemon")[0];
                if (daemon === undefined) {
                    throw new Error("Expected the accepted Runtime connection");
                }
                await relay.webSocketMessage(
                    daemon,
                    typeof message === "string" ? message : new Uint8Array(message).buffer,
                );
                await Promise.all(pending);
            });
        try {
            await deliver(liveEvent(runtime.sessionTarget, "before revocation"));
            expect(await messages.next()).toContain("before revocation");
            await runInDurableObject(env.COMPUTER_RELAY.getByName(runtime.computerId), (_instance, state) => {
                state.storage.sql.exec(`CREATE TRIGGER reject_runtime_disconnect BEFORE UPDATE OF disconnected_at ON runtime_connection
                BEGIN SELECT RAISE(ABORT, 'Controlled disconnect failure'); END`);
            });
            try {
                await expect(runtime.revoke()).rejects.toMatchObject({ code: "runtime_disconnect_failed" });
            } finally {
                await runInDurableObject(env.COMPUTER_RELAY.getByName(runtime.computerId), (_instance, state) => {
                    state.storage.sql.exec("DROP TRIGGER reject_runtime_disconnect");
                });
            }
            // A revoked Runtime's daemon is told so, and stops instead of retrying.
            const reconnected = await runtime.reconnect();
            expect(reconnected.status).toBe(101);
            const refused = reconnected.webSocket;
            if (refused === null) {
                throw new Error("Expected the refused Runtime socket");
            }
            const refusal = new Promise<CloseEvent>((resolve) =>
                refused.addEventListener("close", resolve, { once: true }),
            );
            refused.accept();
            expect(await refusal).toMatchObject({ code: 1008, reason: "Runtime revoked" });
            await deliver(
                format === "text"
                    ? liveEvent(runtime.sessionTarget, "after revocation")
                    : encodeContentChunkFrame({
                          bytes: new Uint8Array([1, 2]),
                          requestId: "revoked-file",
                          sequence: 0,
                      }),
            );
            expect(await runtime.daemonClosed).toMatchObject({ code: 1008, reason: "Runtime revoked" });
            expect(received).toHaveLength(1);
            expect((await runtime.revoke()).status).toBe(204);
        } finally {
            runtime.daemon.close(1000, "Test complete");
            viewer.close(1000, "Test complete");
        }
    },
);

it("Given a Runtime its owner revoked and then paired again, When the earlier daemon reconnects with its saved credential, Then the Relay tells it the Runtime was revoked while the new daemon connects", async () => {
    const runtime = await connectRuntimeDaemon("paired-again");
    try {
        expect((await runtime.revoke()).status).toBe(204);
        expect(await runtime.daemonClosed).toMatchObject({ code: 1008, reason: "Runtime revoked" });
        const replacement = await runtime.pairAgain("paired-again-replacement");

        const earlier = await runtime.reconnect();

        expect(earlier.status).toBe(101);
        const refused = earlier.webSocket;
        if (refused === null) {
            throw new Error("Expected the refused Runtime socket");
        }
        const refusal = new Promise<CloseEvent>((resolve) =>
            refused.addEventListener("close", resolve, { once: true }),
        );
        refused.accept();
        expect(await refusal).toMatchObject({ code: 1008, reason: "Runtime revoked" });
        const connected = await runtime.connect(replacement);
        const daemon = connected.webSocket;
        if (daemon === null) {
            throw new Error("Expected the paired Runtime socket");
        }
        const messages = new SocketMessages(daemon);
        daemon.accept();
        expect(decodeServiceToDaemonMessage(await messages.next()).kind).toBe("runtime.liveness.ready");
        daemon.close(1000, "Test complete");
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

it("Given Chat reads the Session execution naming an unconfirmed command, When the Runtime reports that command's delivery, Then the Relay returns the delivery", async () => {
    const runtime = await connectRuntimeDaemon("command-delivery");
    try {
        const response = runtime.readSessionExecution("unconfirmed-command");
        const first = await Promise.race([
            runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
            response.then((answered) => ({ kind: "response" as const, response: answered })),
        ]);
        if (first.kind === "response") {
            throw new Error(
                `Expected a daemon request, received ${first.response.status}: ${await first.response.text()}`,
            );
        }
        const query = decodeServiceToDaemonMessage(first.message);
        if (query.kind !== "native.session.request" || query.action !== "active-turn") {
            throw new Error("Expected the Session execution read to reach the daemon");
        }
        expect(query.deliveryCommandId).toBe("unconfirmed-command");
        runtime.daemon.send(
            encodeNativeSessionResult({
                kind: "native.session.result",
                action: "active-turn",
                requestId: query.requestId,
                target: runtime.sessionTarget,
                turn: null,
                queued: [],
                command: { state: "completed", stopReason: "end_turn" },
                queuedCancellation: "before-start",
                executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                interactionState: null,
            }),
        );
        expect(await responseJson(await response, 200)).toMatchObject({
            command: { state: "completed", stopReason: "end_turn" },
        });
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

it("Given Chat reads the Session execution after missing a turn's outcome, When the Runtime reports the last turn, Then the Relay returns the outcome", async () => {
    const runtime = await connectRuntimeDaemon("last-turn");
    try {
        const response = runtime.readSessionExecution();
        const first = await Promise.race([
            runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
            response.then((answered) => ({ kind: "response" as const, response: answered })),
        ]);
        if (first.kind === "response") {
            throw new Error(
                `Expected a daemon request, received ${first.response.status}: ${await first.response.text()}`,
            );
        }
        const query = decodeServiceToDaemonMessage(first.message);
        if (query.kind !== "native.session.request" || query.action !== "active-turn") {
            throw new Error("Expected the Session execution read to reach the daemon");
        }
        expect(query).not.toHaveProperty("deliveryCommandId");
        runtime.daemon.send(
            encodeNativeSessionResult({
                kind: "native.session.result",
                action: "active-turn",
                requestId: query.requestId,
                target: runtime.sessionTarget,
                turn: null,
                queued: [],
                queuedCancellation: "before-start",
                executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                interactionState: null,
                lastTurn: {
                    code: "model_unavailable",
                    commandId: "failed-command",
                    message: "The local Agent could not complete the request",
                    state: "failed",
                },
            }),
        );
        expect(await responseJson(await response, 200)).toMatchObject({
            queuedCancellation: "before-start",
            interactionState: null,
            lastTurn: { commandId: "failed-command", state: "failed", code: "model_unavailable" },
        });
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

describe.sequential("Relay Turn submission", () => {
    it.each(["session"] as const)(
        "Given %s access cancels a Turn, When the Runtime reports cancellation or prior completion, Then the response reports the Turn's actual stop reason",
        async (access) => {
            const runtime = await connectRuntimeDaemon(`legacy-queue-cancel-${access.replace(" ", "-")}`);
            try {
                for (const stopReason of ["cancelled", "end_turn"] as const) {
                    const turnId = `legacy-${stopReason}`;
                    const body = {};
                    const path = `/turns/${turnId}/cancel`;
                    const response = runtime.sessionControlRequest(path, body);
                    const cancellation = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
                    expect(cancellation).toEqual({
                        commandId: turnId,
                        kind: "session.cancel",
                        requestId: expect.any(String),
                        target: runtime.sessionTarget,
                    });
                    if (cancellation.kind !== "session.cancel") {
                        throw new Error("Expected a cancellation");
                    }
                    runtime.daemon.send(
                        encodeSessionTurnStoppedEvent({
                            commandId: turnId,
                            kind: "session.turn.stopped",
                            requestId: cancellation.requestId,
                            target: runtime.sessionTarget,
                            stopReason,
                        }),
                    );
                    expect(await responseJson(await response, 200)).toEqual({ turnId, stopReason });
                }
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );

    it.each(["session"] as const)(
        "Given %s access withdraws a queued message, When the Runtime refuses because it already started, Then the conditional endpoint rejects the edit",
        async (access) => {
            const runtime = await connectRuntimeDaemon(`conditional-queue-cancel-${access}`);
            try {
                const body = {};
                const path = "/turns/queued-command/cancel-before-start";
                const response = runtime.sessionControlRequest(path, body);
                const withdrawal = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
                expect(withdrawal).toEqual({
                    commandId: "queued-command",
                    kind: "session.cancel-before-start",
                    requestId: expect.any(String),
                    target: runtime.sessionTarget,
                });
                if (withdrawal.kind !== "session.cancel-before-start") {
                    throw new Error("Expected a withdrawal");
                }
                runtime.daemon.send(
                    encodeSessionOperationFailedEvent({
                        kind: "session.operation.failed",
                        requestId: withdrawal.requestId,
                        target: runtime.sessionTarget,
                        code: "turn_already_started",
                        message: "The message already started and could not be withdrawn",
                    }),
                );
                expect(await responseJson(await response, 409)).toMatchObject({
                    error: { code: "turn_already_started" },
                });
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );

    // @no-uc: Compatibility; trusted backends must control a Runtime Session without delegated Session access.
    it.each([
        {
            label: "cancels the selected message",
            path: "/turns/app-command/cancel",
            method: "POST",
            body: {},
            command: { commandId: "app-command", kind: "session.cancel" },
            reply: { commandId: "app-command", kind: "session.turn.stopped", stopReason: "cancelled" },
            expected: { turnId: "app-command", stopReason: "cancelled" },
        },
        {
            label: "cancels the selected message only before it starts",
            path: "/turns/app-command/cancel-before-start",
            method: "POST",
            body: {},
            command: { commandId: "app-command", kind: "session.cancel-before-start" },
            reply: { commandId: "app-command", kind: "session.turn.withdrawn" },
            expected: { turnId: "app-command" },
        },
        {
            label: "steers the selected queued message",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "steer" },
            command: { commandId: "app-command", disposition: "steer", kind: "session.prompt.disposition" },
            reply: { commandId: "app-command", kind: "session.prompt.steered" },
            expected: { turnId: "app-command" },
        },
        {
            label: "answers a pending permission request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "selected", optionId: "allow_once" },
            command: {
                interactionId: "app-interaction",
                kind: "session.permission.respond",
                outcome: "selected",
                optionId: "allow_once",
            },
            reply: { interactionId: "app-interaction", kind: "session.interaction.answered" },
            expected: { accepted: true },
        },
        {
            label: "answers a pending elicitation request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "accept", content: '{"answer":"continue"}' },
            command: {
                interactionId: "app-interaction",
                kind: "session.elicitation.respond",
                action: "accept",
                content: '{"answer":"continue"}',
            },
            reply: { interactionId: "app-interaction", kind: "session.interaction.answered" },
            expected: { accepted: true },
        },
    ] as const)("Session access $label", async (operation) => {
        const runtime = await connectRuntimeDaemon(`app-control-${operation.command.kind.replaceAll(".", "-")}`);
        try {
            const response = runtime.appSessionRequest(operation.path, operation);
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = decodeServiceToDaemonMessage(first.message);
            expect(command).toMatchObject({ ...operation.command, target: runtime.sessionTarget });
            if (!("requestId" in command)) {
                throw new Error("Expected the command to name its own request");
            }
            runtime.daemon.send(
                JSON.stringify({ ...operation.reply, requestId: command.requestId, target: runtime.sessionTarget }),
            );
            expect(await responseJson(await response, 200)).toMatchObject(operation.expected);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; a read-only App credential must load a Runtime event page through its cursor.
    it("Session access restores a Runtime event page with read permission", async () => {
        const runtime = await connectRuntimeDaemon("app-history");
        try {
            const readOnly = await runtime.issueRuntimeCredential(runtime.computerId);
            const response = runtime.appSessionRequest("/events-v2?limit=2&cursor=previous-event", {
                method: "GET",
                credential: readOnly,
            });
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = decodeServiceToDaemonMessage(first.message);
            expect(command).toMatchObject({
                kind: "session.live-history.v2.page.load",
                target: runtime.sessionTarget,
                eventLimit: 2,
                cursor: "previous-event",
            });
            if (command.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a history request");
            }
            const page = {
                events: [],
                nextCursor: "next-event",
                sessionGenerationId: "session-generation-1",
                tailCursor: "tail-event",
                throughPosition: "3",
                truncated: true,
                version: 2 as const,
            };
            runtime.daemon.send(
                encodeSessionHistoryPageLoaded({
                    kind: "session.live-history.v2.page.loaded",
                    requestId: command.requestId,
                    target: runtime.sessionTarget,
                    events: { events: page, queuedPromptRequests: [] },
                }),
            );
            expect(await responseJson(await response, 200)).toEqual(page);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given Runtime read permission, When an App reads Session configuration, Then the matching Runtime settings are returned without write permission", async () => {
        const runtime = await connectRuntimeDaemon("app-configuration-read");
        try {
            const readOnly = await runtime.issueRuntimeCredential(runtime.computerId);
            const response = runtime.appSessionRequest("/configuration", { method: "GET", credential: readOnly });
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = decodeServiceToDaemonMessage(first.message);
            expect(command).toMatchObject({ kind: "session.config.read", target: runtime.sessionTarget });
            if (command.kind !== "session.config.read") {
                throw new Error("Expected a configuration request");
            }
            const result: SessionConfigReadResult = {
                kind: "session.config.read.result",
                requestId: command.requestId,
                target: runtime.sessionTarget,
                configurationRevision: "revision-1",
                configOptions: [],
            };
            runtime.daemon.send(encodeSessionConfigReadResult(result));
            expect(await responseJson(await response, 200)).toEqual(result);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it.each([
        {
            label: "unsupported append disposition",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "append" },
        },
        {
            label: "invalid permission decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "unknown", optionId: "allow_once" },
        },
        {
            label: "invalid elicitation decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "unknown", content: "" },
        },
        { label: "empty event page", path: "/events-v2?limit=0", method: "GET" },
        { label: "empty event cursor", path: "/events-v2?cursor=", method: "GET" },
    ])("Session access reports $label as an invalid request", async (operation) => {
        const runtime = await connectRuntimeDaemon("app-invalid-request");
        try {
            expect(await responseJson(await runtime.appSessionRequest(operation.path, operation), 400)).toMatchObject({
                error: { code: "invalid_request" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Session access uploads raw attachment chunks before submitting a reference-only Turn", async () => {
        const runtime = await connectRuntimeDaemon("app-binary-attachment");
        try {
            const bytes = new Uint8Array(400 * 1024).map((_value, index) => index % 251);
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            const contentKey = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
            const metadata = {
                kind: "image" as const,
                mediaType: "image/png",
                name: "screenshot.png",
                uri: "attachment:///screenshot.png",
            };
            const upload = runtime.uploadContent(contentKey, bytes, metadata);
            const write = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            expect(write).toMatchObject({
                byteLength: bytes.byteLength,
                contentKey,
                contentKind: "image",
                kind: "content.write",
                target: runtime.sessionTarget,
            });
            if (write.kind !== "content.write") {
                throw new Error("Expected a content write command");
            }
            runtime.daemon.send(
                encodeContentReadyEvent({
                    kind: "content.ready",
                    requestId: write.requestId,
                    target: runtime.sessionTarget,
                }),
            );
            const chunks: Uint8Array[] = [];
            for (;;) {
                const frame = await runtime.daemonMessages.nextFrame();
                if (typeof frame === "string") {
                    const command = decodeServiceToDaemonMessage(frame);
                    if (command.kind === "content.commit" && command.requestId === write.requestId) {
                        break;
                    }
                    continue;
                }
                const arrayBuffer =
                    typeof frame === "object" && frame !== null ? Reflect.get(frame, "arrayBuffer") : undefined;
                const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, frame, []) : frame;
                const chunk = decodeContentChunkFrame(binary);
                expect(chunk.requestId).toBe(write.requestId);
                expect(chunk.sequence).toBe(chunks.length);
                chunks.push(chunk.bytes);
            }
            const uploadedBytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                uploadedBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            expect(uploadedBytes).toEqual(bytes);
            expect(chunks.length).toBeGreaterThan(1);
            runtime.daemon.send(
                encodeContentAvailableEvent({
                    byteLength: bytes.byteLength,
                    contentKey,
                    kind: "content.available",
                    requestId: write.requestId,
                    target: runtime.sessionTarget,
                }),
            );
            const attachment = await responseJson(await upload, 200);
            const attachmentMetadata = {
                kind: metadata.kind,
                mimeType: metadata.mediaType,
                name: metadata.name,
                uri: metadata.uri,
            };
            expect(attachment).toEqual({ byteLength: bytes.byteLength, contentKey, ...attachmentMetadata });

            const idempotencyKey = "binary-attachment-turn";
            const response = runtime.appSessionRequest("/turns", {
                method: "POST",
                body: {
                    content: "Describe the pasted screenshot.",
                    disposition: "append",
                    idempotencyKey,
                    attachments: [attachment],
                    sessionConfigurations: [],
                },
            });
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const encodedPrompt = first.message;
            expect(encodedPrompt).not.toContain("base64");
            expect(encodedPrompt).not.toContain(String(bytes.slice(0, 32)));
            expect(decodeServiceToDaemonMessage(encodedPrompt)).toMatchObject({
                attachments: [{ byteLength: bytes.byteLength, contentKey, ...attachmentMetadata }],
                kind: "session.prompt",
                commandId: idempotencyKey,
            });
            runtime.startTurn(idempotencyKey, "1");
            expect(await responseJson(await response, 200)).toMatchObject({ turnId: idempotencyKey });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given a cancelled file response, When a late chunk arrives, Then the shared daemon remains available", async () => {
        const runtime = await connectRuntimeDaemon("cancelled-file-chunk");
        try {
            const pending = runtime.readFile("/workspace/image.png");
            const read = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (read.kind !== "file.read") {
                throw new Error("Expected a file read command");
            }
            runtime.daemon.send(
                encodeFileBeginEvent({
                    byteLength: 2,
                    kind: "file.begin",
                    mediaType: "image/png",
                    modifiedAt: "2026-09-18T00:00:00.000Z",
                    name: "image.png",
                    requestId: read.requestId,
                    target: runtime.sessionTarget,
                }),
            );
            const response = await pending;
            await response.body?.cancel();

            runtime.daemon.send(
                encodeContentChunkFrame({
                    bytes: new Uint8Array([1, 2]),
                    requestId: read.requestId,
                    sequence: 0,
                }),
            );

            const query = runtime.queryActiveTurn(new AbortController().signal);
            const command = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (command.kind !== "native.session.request") {
                throw new Error("Expected an unrelated native query to reach the daemon");
            }
            runtime.daemon.send(
                encodeNativeSessionResult({
                    action: "active-turn",
                    kind: "native.session.result",
                    queued: [],
                    queuedCancellation: "before-start",
                    executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                    interactionState: null,
                    requestId: command.requestId,
                    target: runtime.sessionTarget,
                    turn: null,
                }),
            );
            expect(await responseJson(await query, 200)).toMatchObject({ action: "active-turn", turn: null });
            expect(runtime.daemon.readyState).toBe(WebSocket.OPEN);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; independent Durable Object clocks must not reject newly issued credentials.
    it.each([900, 30_000])(
        "accepts a Session credential issued %i milliseconds ahead of RuntimeRelay",
        async (skew) => {
            const runtime = await connectRuntimeDaemon(`clock-skew-${skew}`);
            try {
                vi.setSystemTime(Date.now() - skew);
                const submitted = runtime.submitRuntimeTurn("skewed-command");
                const first = await Promise.race([
                    runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
                    submitted.then((response) => ({ kind: "response" as const, response })),
                ]);
                if (first.kind === "response") {
                    throw new Error(
                        `Expected a daemon command, received ${first.response.status}: ${await first.response.text()}`,
                    );
                }
                expect(decodeServiceToDaemonMessage(first.message)).toMatchObject({
                    kind: "session.prompt",
                    commandId: "skewed-command",
                });
                runtime.startTurn("skewed-command", "1");
                expect(await responseJson(await submitted, 200)).toMatchObject({
                    idempotencyKey: "skewed-command",
                    state: { kind: "running" },
                });
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );
    // @no-uc: Technical regression; issuance tolerance must remain bounded and never extend expiry.
    it.each([
        { offset: -30_001, code: "project_credential_invalid" },
        { offset: 900_000, code: "credential_expired" },
    ])("refuses a credential at verifier offset $offset with $code", async ({ offset, code }) => {
        const runtime = await connectRuntimeDaemon(`clock-rejected-${Math.abs(offset)}`);
        try {
            vi.setSystemTime(Date.now() + offset);
            expect(await responseJson(await runtime.submitRuntimeTurn("invalid-time"), 401)).toMatchObject({
                error: { code },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    // @no-uc: Technical regression; future-time tolerance must not admit correctly signed invalid lifetimes.
    it.each([0, -1, 900_001])("refuses a signed credential with lifetime %i", async (lifetime) => {
        const runtime = await connectRuntimeDaemon(`invalid-lifetime-${Math.abs(lifetime)}`);
        try {
            const credential = await runtime.resignCredential(relaySigner, lifetime);
            vi.setSystemTime(Date.now() - 900);
            expect(
                await responseJson(await runtime.submitRuntimeTurn("invalid-lifetime", () => credential), 401),
            ).toMatchObject({ error: { code: "project_credential_invalid" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an authorized token for another Project, When it selects an existing Runtime, Then that Runtime refuses the Project mismatch", async () => {
        const owner = await connectRuntimeDaemon("direct-owner");
        const other = await connectRuntimeDaemon("direct-other-project");
        try {
            const credential = await other.issueRuntimeCredential(owner.computerId);
            expect(
                await responseJson(
                    await other.submitRuntimeTurn("foreign-project", () => credential, undefined, owner.computerId),
                    403,
                ),
            ).toMatchObject({ error: { code: "runtime_access_denied" } });
        } finally {
            owner.daemon.close(1000, "Test complete");
            other.daemon.close(1000, "Test complete");
        }
    });
    it("Given an executing native query, When its HTTP caller cancels, Then cancellation reaches the daemon", async () => {
        const runtime = await connectRuntimeDaemon("direct-cancellation");
        const controller = new AbortController();
        try {
            const pending = runtime.queryActiveTurn(controller.signal).then(
                (response) => response.status,
                (cause: unknown) => cause,
            );
            const command = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (command.kind !== "native.session.request") {
                throw new Error("Expected a native query");
            }
            controller.abort(new DOMException("Caller left", "AbortError"));
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                kind: "native.session.cancel",
                requestId: command.requestId,
            });
            expect(await pending).toBeInstanceOf(DOMException);
        } finally {
            controller.abort();
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When direct Runtime HTTP receives a forged, wrong-Session, or expired credential, Then it rejects the request before execution", async () => {
        const runtime = await connectRuntimeDaemon("direct-authorization");
        try {
            expect(
                await responseJson(
                    await runtime.submitRuntimeTurn("forged", (credential) => `${credential.slice(0, -6)}AAAAAA`),
                    401,
                ),
            ).toMatchObject({ error: { code: "project_credential_invalid" } });
            expect(
                await responseJson(
                    await runtime.submitRuntimeTurn("wrong-session", (credential) => credential, "different-session"),
                    403,
                ),
            ).toMatchObject({ error: { code: "project_permission_denied" } });
            vi.setSystemTime(new Date("2026-09-18T00:16:00.000Z"));
            expect(await responseJson(await runtime.submitRuntimeTurn("expired"), 401)).toMatchObject({
                error: { code: "credential_expired" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an unrelated credential digest, When a Session credential is signed with it, Then direct Runtime HTTP rejects it before execution", async () => {
        const runtime = await connectRuntimeDaemon("stored-digest-forgery");
        try {
            const forged = await runtime.resignCredential(storedDigestSigner);
            expect(
                await responseJson(await runtime.submitRuntimeTurn("stored-digest", () => forged), 401),
            ).toMatchObject({ error: { code: "project_credential_invalid" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an open Session view, When the Relay signing secret rotates, Then the connection check closes the old view and only new credentials reconnect", async () => {
        const runtime = await connectRuntimeDaemon("signing-key-rotation");
        const response = await runtime.subscribe();
        const view = response.webSocket;
        if (view === null) {
            throw new Error("Expected the live Session view");
        }
        const closed = new Promise<CloseEvent>((resolve) => view.addEventListener("close", resolve, { once: true }));
        view.accept();
        try {
            const signingSecret = "rotated-test-only-session-signing-secret";
            const reissued = await runtime.resignCredential(async () => await relaySigningKey(signingSecret));
            const statuses = await runInDurableObject(
                env.COMPUTER_RELAY.getByName(runtime.computerId),
                async (_instance, state) => {
                    // Reconstruct the production object with the same persisted sockets and a newly deployed binding.
                    const rotated = new RelayRuntimeRelay(state, {
                        ...bindings(),
                        MORTY_ALLOWED_ORIGINS: '["*"]',
                        MORTY_SESSION_SIGNING_SECRET: signingSecret,
                    });
                    await rotated.alarm();
                    const connect = async (credential: string) =>
                        await rotated.fetch(
                            new Request(
                                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/events-v2`,
                                { headers: { authorization: `Bearer ${credential}`, Upgrade: "websocket" } },
                            ),
                        );
                    const rejected = await connect(runtime.credential);
                    const accepted = await connect(reissued);
                    accepted.webSocket?.accept();
                    accepted.webSocket?.close(1000, "Test complete");
                    return { old: rejected.status, current: accepted.status };
                },
            );
            expect(statuses).toEqual({ old: 401, current: 101 });
            expect(await closed).toMatchObject({ code: 1008, reason: "Session signing key rotated" });
        } finally {
            view.close(1000, "Test complete");
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When HTTP reaches RuntimeRelay directly, Then the command executes without a project relay hop and remains correlated", async () => {
        const runtime = await connectRuntimeDaemon("direct-runtime");
        try {
            const submitted = runtime.submitRuntimeTurn("direct-command");
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                submitted.then((response) => ({ kind: "response", message: String(response.status) })),
            ]);
            expect(first.kind).toBe("command");
            expect(decodeServiceToDaemonMessage(first.message)).toMatchObject({
                kind: "session.prompt",
                commandId: "direct-command",
            });
            runtime.startTurn("direct-command", "1");
            expect(await responseJson(await submitted, 200)).toMatchObject({ state: { kind: "running" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a linked Runtime, When Chat submits a first Turn longer than 10,000 characters or an invalid Turn, Then the long Turn reaches the Runtime and the invalid Turn is rejected as a client error", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const _backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "long-prompt-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        machineName: "Long prompt Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "long-prompt-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        const sessionId = "long-prompt-session";
        const daemonCredential = new DaemonCredential(text(claimed, "runtimeCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Runtime socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
            const submitTurn = (idempotencyKey: string, content: string, attachments: readonly unknown[]) =>
                worker.fetch(
                    new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                        {
                            body: JSON.stringify({
                                content,
                                idempotencyKey,
                                attachments,
                            }),
                            headers: credentialHeaders(text(sessionAccess, "credential")),
                            method: "POST",
                        },
                    ),
                    environment,
                );

            // First Turns carry the teammate's instructions ahead of the user's message.
            const longPrompt = `${"instruction ".repeat(2_000)}\n\nsummarize the workspace`;
            expect(longPrompt.length).toBeGreaterThan(20_000);
            const longTurn = submitTurn("long-first-turn", longPrompt, []);
            const delivered = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (delivered.kind !== "session.prompt") {
                throw new Error("Expected the long Turn to reach the Runtime");
            }
            expect(delivered.prompt).toBe(longPrompt);
            daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: delivered.commandId,
                    target: nativeTarget(sessionId),
                    state: "running",
                }),
            );
            expect(await responseJson(await longTurn, 200)).toMatchObject({
                state: { kind: "running" },
                turnId: "long-first-turn",
            });

            // A cancellation is answered only by the reply naming its own request: a failure naming the Turn it
            // cancels, or another Turn's lifecycle, leaves it waiting.
            const cancelTurn = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns/long-first-turn/cancel`,
                    {
                        body: JSON.stringify({}),
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
                environment,
            );
            const cancellation = decodeServiceToDaemonMessage(await daemonMessages.next());
            if (cancellation.kind !== "session.cancel") {
                throw new Error("Expected the cancellation to reach the Runtime");
            }
            expect(cancellation.requestId).not.toBe(cancellation.commandId);
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "agent_execution_failed",
                    kind: "session.operation.failed",
                    message: "The local agent could not complete the request",
                    requestId: "long-first-turn",
                    target: nativeTarget(sessionId),
                }),
            );
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: "long-first-completed",
                            position: "3",
                            recordedAt: "2026-09-18T00:00:02.000Z",
                            sessionGenerationId: "session-generation-1",
                            target: nativeTarget(sessionId),
                            type: "lifecycle-metadata",
                            payload: {
                                commandId: "long-first-turn",
                                kind: "prompt.completed",
                                stopReason: "cancelled",
                            },
                        },
                    ],
                }),
            );
            daemon.send(
                encodeSessionTurnStoppedEvent({
                    commandId: "long-first-turn",
                    kind: "session.turn.stopped",
                    requestId: cancellation.requestId,
                    target: nativeTarget(sessionId),
                    stopReason: "cancelled",
                }),
            );
            expect(await responseJson(await cancelTurn, 200)).toEqual({
                stopReason: "cancelled",
                turnId: "long-first-turn",
            });

            // An appended Turn the Runtime queues is answered as queued.
            const queuedTurn = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                    {
                        body: JSON.stringify({
                            content: "queue this follow-up",
                            idempotencyKey: "queued-follow-up",
                            attachments: [],
                        }),
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
                environment,
            );
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("session.prompt");
            daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: "queued-follow-up",
                    target: nativeTarget(sessionId),
                    state: "queued",
                }),
            );
            expect(await responseJson(await queuedTurn, 200)).toMatchObject({
                state: { kind: "queued" },
                turnId: "queued-follow-up",
            });

            expect(
                await responseJson(await submitTurn("invalid-image-turn", "describe this", [{ kind: "image" }]), 400),
            ).toMatchObject({ error: { code: "invalid_request" } });
            expect(await responseJson(await submitTurn("oversized-turn", "x".repeat(100_001), []), 400)).toMatchObject({
                error: { code: "invalid_request" },
            });
            expect(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                            {
                                body: JSON.stringify({
                                    content: "describe this",
                                    disposition: "append",
                                    idempotencyKey: "invalid-runtime-turn",
                                    attachments: [{ kind: "image" }],
                                    sessionConfigurations: [],
                                }),
                                headers: credentialHeaders(sessionAccess.credential),
                                method: "POST",
                            },
                        ),
                        environment,
                    ),
                    400,
                ),
            ).toMatchObject({ error: { code: "invalid_request" } });
            // A malformed settings change is the caller's error on the Session surface too.
            expect(
                await responseJson(
                    await worker.fetch(
                        new Request(
                            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/configuration`,
                            {
                                body: JSON.stringify({ configId: "model", valueType: "select", value: "gpt" }),
                                headers: credentialHeaders(text(sessionAccess, "credential")),
                                method: "POST",
                            },
                        ),
                        environment,
                    ),
                    400,
                ),
            ).toMatchObject({ error: { code: "invalid_request" } });
        } finally {
            daemon.close();
        }
    });

    it("Given an Agent whose capability advertisement withholds steering and Session renaming, When Chat steers a Turn or renames the Session, Then the Relay forwards both and the Runtime's own answer decides", async () => {
        const gatedAgent = readyAgents[0];
        if (gatedAgent === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "capability-gated-commands-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`, {
                    body: JSON.stringify({
                        agents: [
                            {
                                ...gatedAgent,
                                // The Agent withholds both command capabilities, so pairing
                                // must still succeed and only the commands are rejected.
                                capabilities: {
                                    ...gatedAgent.capabilities,
                                    renameSession: false,
                                    steering: false,
                                },
                            },
                        ],
                        machineName: "Capability-gated commands Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "capability-gated-commands-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        const sessionId = "capability-gated-session";
        const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
        const sessionCredential = text(sessionAccess, "credential");

        // Pairing succeeded, so the Agent remains listed with its capabilities.
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({
            agents: [{ harness: "codex", label: "Codex" }],
            computerId,
        });

        // The Relay no longer decides from the catalog. It forwards the steer
        // to the Runtime, whose own rejection answers with the same
        // machine-readable code and a terminal status.
        const daemonCredential = new DaemonCredential(text(claimed, "runtimeCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Runtime socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeServiceToDaemonMessage(await daemonMessages.next()).kind).toBe("runtime.liveness.ready");
            const steer = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns/some-active-turn/disposition`,
                    {
                        body: JSON.stringify({ disposition: "steer" }),
                        headers: credentialHeaders(sessionCredential),
                        method: "PUT",
                    },
                ),
                environment,
            );
            const forwarded = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(forwarded).toMatchObject({ kind: "session.prompt.disposition", target: nativeTarget(sessionId) });
            if (forwarded.kind !== "session.prompt.disposition") {
                throw new Error("Expected the steer to reach the Runtime");
            }
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "steering_unsupported",
                    kind: "session.operation.failed",
                    message: "The selected agent does not support mid-turn steering",
                    requestId: forwarded.requestId,
                    target: nativeTarget(sessionId),
                }),
            );
            expect(await responseJson(await steer, 409)).toMatchObject({
                error: { code: "steering_unsupported" },
            });

            // A rename forwards unchanged even though no listed Agent
            // advertises renaming: the Runtime renames the stored Session
            // itself, exactly as it does for Agents without the extension.
            const rename = worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/rename`,
                    {
                        body: JSON.stringify({ title: "Renamed despite the withheld capability" }),
                        headers: credentialHeaders(sessionCredential),
                        method: "POST",
                    },
                ),
                environment,
            );
            const renameCommand = decodeServiceToDaemonMessage(await daemonMessages.next());
            expect(renameCommand).toMatchObject({ kind: "session.rename", target: nativeTarget(sessionId) });
            daemon.send(
                encodeSessionRenamedEvent({
                    kind: "session.renamed",
                    requestId: renameCommand.kind === "session.rename" ? renameCommand.requestId : "",
                    target: nativeTarget(sessionId),
                    title: "Renamed despite the withheld capability",
                    updatedAt: "2030-01-01T00:00:00.000Z",
                }),
            );
            expect(await responseJson(await rename, 200)).toMatchObject({
                kind: "session.renamed",
                target: nativeTarget(sessionId),
                title: "Renamed despite the withheld capability",
            });
        } finally {
            daemon.close(1000, "Test complete");
        }
    });

    it("Given an Agent advertisement carrying fields and capability values the Relay cannot interpret, When it pairs, Then pairing rejects the invalid capabilities", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(), createRelayGateways);
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const _backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/computers/${computerId}/management/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "malformed-capabilities-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const advertised = readyAgents[0];
        if (advertised === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
        const malformed = {
            ...advertised,
            capabilities: {
                ...advertised.capabilities,
                renameSession: "yes",
                steering: null,
            },
        };
        const rejected = await responseJson(
            await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/pairings/${text(pairing, "computerId")}/redeem`, {
                    body: JSON.stringify({
                        agents: [malformed],
                        machineName: "Malformed capabilities Runtime",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "malformed-capabilities-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            400,
        );
        expect(rejected).toMatchObject({ error: { code: "invalid_agents" } });
    });

    it("Given a daemon that heartbeats and then falls silent, When Chat submits Turns, Then they reach it while it heartbeats and are refused as runtime_offline once the silence outlasts the heartbeat deadline", async () => {
        const runtime = await connectRuntimeDaemon("silent-daemon", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 20_000);
            const delivered = runtime.submitTurn("heartbeating-turn");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "heartbeating-turn",
                kind: "session.prompt",
            });
            runtime.startTurn("heartbeating-turn", "1");
            expect(await responseJson(await delivered, 200)).toMatchObject({ turnId: "heartbeating-turn" });

            // A Turn sent before the deadline still reaches the connection, which never answers it.
            vi.setSystemTime(heartbeatAt + 30_000);
            const stranded = runtime.submitTurn("stranded-turn");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "stranded-turn",
                kind: "session.prompt",
            });

            // Once the silence outlasts the deadline, the next Turn is refused at once and releases the stranded one.
            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await responseJson(await runtime.submitTurn("after-silence-turn"), 503)).toMatchObject({
                error: { code: "runtime_offline" },
            });
            expect(await responseJson(await stranded, 503)).toMatchObject({ error: { code: "runtime_offline" } });
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            // Cloudflare's clock has not reached the times set above, and the run does not finish
            // tearing down while the test clock is still ahead of it.
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it.each([
        { kind: "permission", responderId: "member-1", outcome: "selected", optionId: "allow_once" },
        { kind: "elicitation", responderId: "member-1", action: "accept", content: '{"answer":"continue"}' },
    ] as const)(
        "Given a daemon whose heartbeats stopped, When an app answers a pending $kind request, Then the answer is refused at once as runtime_offline",
        async (body) => {
            const runtime = await connectRuntimeDaemon(`offline-${body.kind}-answer`, { anchorClockToHeartbeat: true });
            // The clock now reads when Cloudflare answered the daemon's heartbeat.
            const heartbeatAt = Date.now();
            try {
                vi.setSystemTime(heartbeatAt + 36_000);
                const answer = await runtime.appSessionRequest("/interactions/offline-interaction/responses", {
                    method: "POST",
                    body,
                });
                expect(await responseJson(answer, 503)).toMatchObject({ error: { code: "runtime_offline" } });
                expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
            } finally {
                vi.setSystemTime(heartbeatAt);
                runtime.daemon.close();
            }
        },
    );

    it("Given a daemon whose heartbeats stopped, When an app reads the Runtime, Then it is reported offline and its connection is closed", async () => {
        const runtime = await connectRuntimeDaemon("silent-presence", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 30_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon using fixed-text heartbeats, When it sends a noncanonical heartbeat near its deadline, Then only host auto-responses renew its liveness", async () => {
        const runtime = await connectRuntimeDaemon("noncanonical-heartbeat", { anchorClockToHeartbeat: true });
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 30_000);
            runtime.daemon.send(JSON.stringify({ extra: "ignored", kind: "runtime.heartbeat" }));
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon that never heartbeats after it connected, When its first heartbeat is overdue, Then it is reported offline and its connection is closed", async () => {
        const runtime = await connectRuntimeDaemon("unproven-daemon");
        const connectedAt = Date.now();
        try {
            // The first heartbeat follows attachment, which has 30 seconds, then the usual silence limit applies.
            vi.setSystemTime(connectedAt + 65_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(connectedAt + 65_001);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Runtime heartbeat timed out" });
        } finally {
            vi.setSystemTime(connectedAt);
            runtime.daemon.close();
        }
    });
});

function forkResult(requestId: string, target: NativeSessionTarget) {
    return {
        kind: "native.session.result",
        action: "fork",
        requestId,
        target,
        title: "Source (fork 1)",
        ready: {
            kind: "session.ready",
            requestId,
            target,
            harness: "codex",
            agentName: "Codex",
            agentVersion: "1.0.0",
            restored: true,
            directory: ".",
            directoryLabel: "Workspace",
            configurationRevision: "revision-1",
            capabilities: readyAgents[0]?.capabilities,
            commands: [],
            configOptions: [],
        },
    };
}

it("Given a Fork in flight, When it is requested again concurrently and after Relay eviction, Then each Runtime request carries the operation identity and the Relay keeps no outcome of its own", async () => {
    const runtime = await connectRuntimeDaemon("fork-operation-identity");
    const input = {
        harness: "codex",
        sessionId: "native-source",
        directory: ".",
    };
    const operationId = "retained-fork-operation";
    try {
        const first = runtime.forkNative(operationId, input);
        // The controlled daemon owns fork allocation; the request never carries a destination.
        const fork = record(JSON.parse(await runtime.daemonMessages.next()));
        expect(fork).toMatchObject({
            kind: "native.session.request",
            action: "fork",
            requestId: expect.any(String),
            sessionId: "native-source",
            directory: ".",
        });
        expect(fork).not.toHaveProperty("targetSessionId");
        const concurrent = runtime.forkNative(operationId, input);
        expect(
            await responseJson(await runtime.forkNative(operationId, { ...input, sessionId: "another-source" }), 409),
        ).toMatchObject({ error: { code: "idempotency_conflict" } });
        const forkTarget = nativeTarget("harness-fork-destination");
        runtime.daemon.send(JSON.stringify(forkResult(text(fork, "requestId"), forkTarget)));

        const original = await responseJson(await first, 200);

        expect(original).toMatchObject({ action: "fork", target: forkTarget });
        expect(await responseJson(await concurrent, 200)).toEqual(original);

        await evictDurableObject(env.COMPUTER_RELAY.getByName(runtime.computerId), { webSockets: "hibernate" });
        const replayed = runtime.forkNative(operationId, input);
        // The Runtime answers the retry from the receipt it keeps under the same operation identity.
        expect(record(JSON.parse(await runtime.daemonMessages.next()))).toEqual(fork);
        runtime.daemon.send(JSON.stringify(forkResult(text(fork, "requestId"), forkTarget)));
        expect(await responseJson(await replayed, 200)).toEqual(original);
    } finally {
        runtime.daemon.close(1000, "Fork recovery scenario completed");
    }
});

it("Given the Runtime rejects a Fork, When the same operation is retried, Then the rejection is reported and the retry forks again", async () => {
    const runtime = await connectRuntimeDaemon("fork-rejected");
    const input = {
        harness: "codex",
        sessionId: "native-source",
        directory: ".",
    };
    const operationId = "rejected-fork-operation";
    const forkCommand = async () => {
        const fork = record(JSON.parse(await runtime.daemonMessages.next()));
        expect(fork).toMatchObject({ kind: "native.session.request", action: "fork", sessionId: "native-source" });
        return fork;
    };
    try {
        const first = runtime.forkNative(operationId, input);
        const rejected = await forkCommand();
        runtime.daemon.send(
            JSON.stringify({
                kind: "session.operation.failed",
                code: "native_session_unsupported",
                message: "This Agent does not support session forking",
                requestId: text(rejected, "requestId"),
            }),
        );
        expect(await responseJson(await first, 503)).toMatchObject({ error: { code: "native_session_unsupported" } });

        const retried = runtime.forkNative(operationId, input);
        const fork = await forkCommand();
        expect(text(fork, "requestId")).toBe(text(rejected, "requestId"));
        expect(fork).not.toHaveProperty("targetSessionId");
        const forkTarget = nativeTarget("harness-fork-after-refusal");
        runtime.daemon.send(JSON.stringify(forkResult(text(fork, "requestId"), forkTarget)));
        const forked = await responseJson(await retried, 200);
        expect(forked).toMatchObject({ action: "fork", target: forkTarget });
    } finally {
        runtime.daemon.close(1000, "Fork rejection scenario completed");
    }
});

it("Given an anonymous browser knows a Runtime, When it declares a full-budget upload, Then it is rejected and an authorized browser can still upload", async () => {
    const runtime = await connectRuntimeDaemon("upload-admission");
    const anonymous = (await runtime.transport()).webSocket;
    const browser = (await runtime.transport()).webSocket;
    if (anonymous === null || browser === null) {
        throw new Error("Expected browser transports");
    }
    const anonymousMessages = new SocketMessages(anonymous);
    const browserMessages = new SocketMessages(browser);
    anonymous.accept();
    browser.accept();
    const path =
        MORTY_API_PREFIX +
        "/v1/computers/" +
        runtime.computerId +
        "/harnesses/" +
        runtime.sessionTarget.harness +
        "/sessions/" +
        runtime.sessionTarget.sessionId +
        "/content/" +
        "a".repeat(64);
    // Alter the first character of the 43-character signature. Its last character carries two
    // padding bits that decoding ignores, so editing that one can leave the signature valid.
    const signatureStart = runtime.credential.length - 43;
    const forgedCredential =
        runtime.credential.slice(0, signatureStart) +
        (runtime.credential[signatureStart] === "A" ? "B" : "A") +
        runtime.credential.slice(signatureStart + 1);
    const declaration = {
        kind: "http.request",
        requestId: "unauthorized",
        method: "PUT",
        path,
        body: "",
        bodyByteLength: 12_582_912,
        headers: [["authorization", `Bearer ${forgedCredential}`]],
    };
    try {
        anonymous.send(JSON.stringify({ ...declaration, headers: [], requestId: "missing-credential" }));
        expect(JSON.parse(await anonymousMessages.next())).toMatchObject({
            kind: "http.error",
            code: "invalid_target",
            requestId: "missing-credential",
            status: 400,
        });
        anonymous.send(JSON.stringify(declaration));
        expect(JSON.parse(await anonymousMessages.next())).toMatchObject({
            kind: "http.response",
            requestId: "unauthorized",
            status: 401,
        });
        browser.send(
            JSON.stringify({
                ...declaration,
                requestId: "authorized",
                bodyByteLength: 1,
                headers: [
                    ["authorization", `Bearer ${runtime.credential}`],
                    ["x-morty-byte-length", "1"],
                    ["x-morty-content-kind", "resource"],
                    ["content-type", "text/plain"],
                    ["x-morty-file-name", "test.txt"],
                ],
                path: `${path}?uri=file%3A%2F%2F%2Ftmp%2Ftest.txt`,
            }),
        );
        browser.send(encodeContentChunkFrame({ requestId: "authorized", sequence: 0, bytes: new Uint8Array([120]) }));
        const command = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
        expect(command.kind).toBe("content.write");
        if (command.kind !== "content.write") {
            throw new Error("Expected authorized upload");
        }
        runtime.daemon.send(
            encodeContentReadyEvent({
                kind: "content.ready",
                requestId: command.requestId,
                target: runtime.sessionTarget,
            }),
        );
        const frame = await runtime.daemonMessages.nextFrame();
        const arrayBuffer = typeof frame === "object" && frame !== null ? Reflect.get(frame, "arrayBuffer") : undefined;
        const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, frame, []) : frame;
        expect(decodeContentChunkFrame(binary).bytes).toEqual(new Uint8Array([120]));
        expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
            kind: "content.commit",
            requestId: command.requestId,
        });
        runtime.daemon.send(
            encodeContentAvailableEvent({
                kind: "content.available",
                requestId: command.requestId,
                target: runtime.sessionTarget,
                contentKey: "a".repeat(64),
                byteLength: 1,
            }),
        );
        expect(JSON.parse(await browserMessages.next())).toMatchObject({ kind: "http.response", status: 200 });
    } finally {
        anonymous.close();
        browser.close();
        runtime.daemon.close();
    }
});

describe("Runtime prompt acknowledgements", () => {
    const lifecycleFrame = (
        sessionTarget: NativeSessionTarget,
        eventId: string,
        position: string,
        payload: Record<string, unknown>,
    ) =>
        encodeSessionEventEnvelope({
            kind: "session.event.v2",
            events: [
                {
                    eventId,
                    position,
                    recordedAt: new Date().toISOString(),
                    sessionGenerationId: "session-generation-1",
                    target: sessionTarget,
                    type: "lifecycle-metadata",
                    payload: payload as never,
                },
            ],
        });

    it("Given pending submissions, When the Runtime answers another request, Then only the reply naming each submission answers it", async () => {
        const runtime = await connectRuntimeDaemon("named-queue-change");
        try {
            const credential = await runtime.issueRuntimeCredential(runtime.computerId);
            const queue = (idempotencyKey: string) =>
                env.COMPUTER_RELAY.getByName(runtime.computerId).fetch(
                    new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                        {
                            method: "POST",
                            headers: credentialHeaders(credential),
                            body: JSON.stringify({
                                attachments: [],
                                content: `queued ${idempotencyKey}`,
                                idempotencyKey,
                            }),
                        },
                    ),
                );

            const rejected = queue("rejected-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "rejected-command",
            });
            // Another request's answer, or this command's own lifecycle, does not answer this submission; the
            // Runtime's reply naming it does.
            runtime.daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: "other-command",
                    target: runtime.sessionTarget,
                    state: "queued",
                }),
            );
            runtime.daemon.send(
                lifecycleFrame(runtime.sessionTarget, "rejected-failed", "1", {
                    code: "agent_unavailable",
                    commandId: "rejected-command",
                    kind: "prompt.failed-before-start",
                    message: "The Agent is unavailable",
                }),
            );
            runtime.daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "agent_unavailable",
                    kind: "session.operation.failed",
                    message: "The Agent is unavailable",
                    requestId: "rejected-command",
                    target: runtime.sessionTarget,
                }),
            );
            const failure = await rejected;
            expect(failure.status).not.toBe(200);
            expect(await failure.json()).toMatchObject({ error: { code: "agent_unavailable" } });

            const admitted = queue("admitted-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "admitted-command",
            });
            runtime.daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: "admitted-command",
                    target: runtime.sessionTarget,
                    state: "queued",
                }),
            );
            expect(await responseJson(await admitted, 200)).toMatchObject({
                state: { kind: "queued" },
                turnId: "admitted-command",
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);

    it("Given a completed prompt, When it is retried with the same command identifier, Then the Runtime's acceptance answers the retry", async () => {
        const runtime = await connectRuntimeDaemon("retried-prompt");
        try {
            const first = runtime.submitRuntimeTurn("retried-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "retried-command",
                kind: "session.prompt",
            });
            runtime.startTurn("retried-command", "1");
            expect((await first).status).toBe(200);
            runtime.daemon.send(
                lifecycleFrame(runtime.sessionTarget, "retried-completed", "2", {
                    commandId: "retried-command",
                    kind: "prompt.completed",
                    stopReason: "end_turn",
                }),
            );

            const retry = runtime.submitRuntimeTurn("retried-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "retried-command",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                JSON.stringify({
                    kind: "session.prompt.accepted",
                    requestId: "retried-command",
                    target: runtime.sessionTarget,
                    state: "settled",
                }),
            );
            expect(await responseJson(await retry, 200)).toMatchObject({ turnId: "retried-command" });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);

    it("Given a prompt that already settled, When it is retried with the same idempotency key, Then the Turn is reported indeterminate instead of running", async () => {
        const runtime = await connectRuntimeDaemon("settled-retry");
        try {
            const retry = runtime.submitRuntimeTurn("settled-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "settled-command",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                JSON.stringify({
                    kind: "session.prompt.accepted",
                    requestId: "settled-command",
                    target: runtime.sessionTarget,
                    state: "settled",
                }),
            );
            expect(await responseJson(await retry, 200)).toMatchObject({
                state: {
                    kind: "indeterminate",
                    reconciliation: { detectedAt: "2026-09-18T00:00:00.000Z", reason: "dispatch_indeterminate" },
                },
                turnId: "settled-command",
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);
    it("Given a submitted prompt whose Agent is still starting, When the Turn is cancelled before it starts, Then the submission is answered by that outcome instead of waiting for its deadline", async () => {
        const runtime = await connectRuntimeDaemon("cancelled-before-start");
        try {
            const submission = runtime.submitTurn("preparing-command");
            expect(decodeServiceToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                commandId: "preparing-command",
                kind: "session.prompt",
            });
            const cancel = runtime.sessionControlRequest("/turns/preparing-command/cancel", {});
            const cancellation = decodeServiceToDaemonMessage(await runtime.daemonMessages.next());
            if (cancellation.kind !== "session.cancel") {
                throw new Error("Expected the cancellation to reach the Runtime");
            }
            expect(cancellation.commandId).toBe("preparing-command");
            // A command cancelled before it starts answers its submission as settled, and the cancellation with
            // how it stopped.
            runtime.daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: "preparing-command",
                    target: runtime.sessionTarget,
                    state: "settled",
                }),
            );
            runtime.daemon.send(
                encodeSessionTurnStoppedEvent({
                    commandId: "preparing-command",
                    kind: "session.turn.stopped",
                    requestId: cancellation.requestId,
                    target: runtime.sessionTarget,
                    stopReason: "cancelled",
                }),
            );

            expect(await responseJson(await cancel, 200)).toMatchObject({ stopReason: "cancelled" });
            expect(await responseJson(await submission, 200)).toMatchObject({
                state: { kind: "indeterminate", reconciliation: { reason: "dispatch_indeterminate" } },
                turnId: "preparing-command",
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);
});
