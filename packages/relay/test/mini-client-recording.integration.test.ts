import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectoryV2,
    decodeSessionRecordingHistory,
    decodeSessionRecordingSummaryV2,
    encodeSessionEventEnvelope,
    MORTY_API_PREFIX,
} from "@morty-build/client/protocol";
import { MortyClient, StaticMortyCredentialProvider } from "@morty-build/client/server";
import { DurableObjectSqlDatabase, RuntimeRelay } from "@morty-build/relay-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMortyPlatformApp } from "../../platform-test-support/src/app.ts";
import { seedMortyService, setMortyRecording } from "../../platform-test-support/src/service-fixture.ts";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
import {
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

const relayOrigin = "https://platform.test";

function bindings(): PlatformRelayBindings {
    if (env.RECORDING === undefined || typeof env.RECORDING_PROVIDER_ID !== "string") {
        throw new Error("Expected the Recording provider binding");
    }
    return {
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RECORDING: env.RECORDING,
        RECORDING_PROVIDER_ID: env.RECORDING_PROVIDER_ID,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
        MORTY_SESSION_SIGNING_SECRET: env.MORTY_SESSION_SIGNING_SECRET,
    };
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
    expect(response.status).toBe(status);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
}

function text(value: Record<string, unknown>, key: string): string {
    const result = value[key];
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return result;
}

function turnMessage(sessionId: string): string {
    return encodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: `${sessionId}-requested`,
                position: "0",
                recordedAt: "2026-10-12T00:00:00.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "lifecycle-metadata",
                payload: {
                    kind: "prompt.requested",
                    commandId: "turn-1",
                    content: [{ type: "text", text: "Mini-client recording prompt" }],
                    context: { agentId: "codex", directoryId: "default", additionalDirectoryIds: [] },
                },
            },
            {
                eventId: `${sessionId}-reply`,
                position: "1",
                recordedAt: "2026-10-12T00:00:01.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Durable mini-client reply" },
                },
            },
            {
                eventId: `${sessionId}-completed`,
                position: "2",
                recordedAt: "2026-10-12T00:00:02.000Z",
                sessionGenerationId: `${sessionId}-generation`,
                sessionId,
                type: "lifecycle-metadata",
                payload: { kind: "prompt.completed", commandId: "turn-1", stopReason: "end_turn" },
            },
        ],
    });
}

async function recordThroughRelay(projectId: string, runtimeId: string, messages: readonly string[]): Promise<void> {
    await registerRuntimeFixture(projectId, runtimeId);
    await runInDurableObject(env.RUNTIME_RELAY.getByName(projectId), async (_instance, state) => {
        const pending: Promise<void>[] = [];
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, bindings(), { database });
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: context.storages,
                gateways: context.gateways,
                utilities: { waitUntil: (operation) => pending.push(operation) },
            }),
        );
        const response = await relay.fetch(
            new Request(`https://runtime.internal/projects/${projectId}/daemon`, {
                headers: {
                    Upgrade: "websocket",
                    "x-morty-runtime-id": runtimeId,
                    "x-morty-channel-id": runtimeId,
                },
            }),
        );
        expect(response.status).toBe(101);
        const client = response.webSocket;
        const daemon = state.getWebSockets("daemon")[0];
        if (client === null || daemon === undefined) {
            throw new Error("Expected a connected daemon");
        }
        client.accept();
        try {
            // Delivered back to back, as a streaming Agent does, without waiting for any write.
            await Promise.all(messages.map((message) => relay.webSocketMessage(daemon, message)));
            await Promise.all(pending.splice(0));
        } finally {
            client.close(1000, "Mini-client Recording test complete");
            await Promise.allSettled(pending);
        }
    });
}

async function createRecordingProject(): Promise<{
    readonly credential: string;
    readonly environment: PlatformRelayBindings;
    readonly projectId: string;
    readonly worker: ReturnType<typeof createTestMortyPlatformApp>;
}> {
    const worker = createTestMortyPlatformApp(new PlatformAuthenticationConfiguration(), createPlatformGateways);
    const environment = bindings();

    const app = await seedMortyService(env.PLATFORM_DIRECTORY_DATABASE);
    const credentialValue = app["defaultCredential"];
    if (typeof credentialValue !== "object" || credentialValue === null) {
        throw new Error("Expected a default AppCredential");
    }
    const credential = text(credentialValue as Record<string, unknown>, "credential");
    const project = await json(
        await worker.fetch(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/dashboard/v1/apps/${text(app, "appId")}/projects`, {
                body: JSON.stringify({
                    displayName: "Mini-client Recording Project",
                    idempotencyKey: `mini-recording-${Date.now()}`,
                    locationHint: "wnam",
                }),
                headers: {
                    authorization: `Bearer ${app.defaultCredential.credential}`,
                    "content-type": "application/json",
                },
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const projectId = text(project, "projectId");
    await setMortyRecording(env.PLATFORM_DIRECTORY_DATABASE, app.appId, "enabled");
    return { credential, environment, projectId, worker };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
});

describe.sequential("Mini-client Recording integration", () => {
    it.each([
        { type: "acp", contentType: "text" },
        { type: "acp", contentType: "future_content" },
        { type: "future-event", contentType: "text" },
    ])(
        "Given a newer daemon with $type/$contentType and extension fields, When events cross the relay and Recording, Then full and paged history retain the original events",
        async ({ type, contentType }) => {
            const { credential, environment, projectId, worker } = await createRecordingProject();
            const runtimeId = "runtime-future-recording";
            const sessionId = "future-recording-session";
            // Independently authored wire data: the current SDK encoder would strip or reject these additions.
            const event = {
                eventId: "future-event",
                position: "1",
                recordedAt: "2026-10-12T00:00:00.000Z",
                sessionGenerationId: "future-generation",
                sessionId,
                type,
                futureEventField: { retained: true },
                mortyMetadata: { futureMetadata: "retained" },
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    futurePayloadField: "retained",
                    content: { type: contentType, text: "Future reply", futureContentField: [1, 2, 3] },
                },
            };
            await recordThroughRelay(projectId, runtimeId, [
                JSON.stringify({ kind: "session.event.v2", events: [event] }),
            ]);
            for (const paging of ["", "&limit=100"]) {
                const response = await worker.request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/projects/${projectId}/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}${paging}`,
                    { headers: { authorization: `Bearer ${credential}` } },
                    environment,
                );
                expect(response.status).toBe(200);
                expect(response.headers.get("Server-Timing")).toMatch(/platform-authorize;dur=[0-9.]+/u);
                if (paging !== "") {
                    expect(response.headers.get("Server-Timing")).toMatch(/recording-read;dur=[0-9.]+/u);
                }
                expect(await response.json()).toMatchObject({ sessionId, events: [event] });
            }
        },
    );

    it("Given an enabled Project and recorded Turn, When a mini-client reads through MortyClient, Then it sees durable history and the session directory", async () => {
        const { credential, environment, projectId, worker } = await createRecordingProject();

        const runtimeId = "runtime-mini-recording";
        const sessionId = "mini-client-recording-session";
        await recordThroughRelay(projectId, runtimeId, [turnMessage(sessionId)]);

        new MortyClient({
            credentialProvider: new StaticMortyCredentialProvider(credential),
            endpoint: relayOrigin,
            projectId,
            transport: {
                fetch: async (request) => await worker.request(request, undefined, environment, undefined),
            },
        });
        const history = await json(
            await worker.request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/projects/${projectId}/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        expect(decodeSessionRecordingHistory(JSON.stringify(history))).toMatchObject({
            sessionId,
            events: [
                { eventId: `${sessionId}-requested`, position: "0" },
                {
                    eventId: `${sessionId}-reply`,
                    payload: { content: { text: "Durable mini-client reply" } },
                    position: "1",
                },
                { eventId: `${sessionId}-completed`, position: "2" },
            ],
        });
        const summaryPath = `${relayOrigin}${MORTY_API_PREFIX}/v2/projects/${projectId}/recording/sessions`;
        const metadata = await json(
            await worker.request(
                `${summaryPath}?runtimeId=${runtimeId}&sessionId=${sessionId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        const summaries = decodeSessionRecordingDirectoryV2(JSON.stringify(metadata));
        expect(summaries.sessions).toEqual([
            expect.objectContaining({ sessionId, title: "Mini-client recording prompt" }),
        ]);
        expect(metadata).toEqual(summaries);
        const single = await json(
            await worker.request(
                `${summaryPath}/${sessionId}?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        expect(single).toEqual(decodeSessionRecordingSummaryV2(JSON.stringify(single)));
        expect(single).toEqual(summaries.sessions[0]);
        const denied = await worker.request(`${summaryPath}?runtimeId=${runtimeId}`, {}, environment);
        expect(denied.status).toBe(401);
    });

    it("Given an Agent streaming hundreds of reply chunks back to back, When history is read, Then every chunk is recorded in order", async () => {
        const { credential, environment, projectId, worker } = await createRecordingProject();
        const runtimeId = "runtime-streamed-recording";
        const sessionId = "streamed-recording-session";
        const chunkCount = 400;
        const messages = Array.from({ length: chunkCount }, (_, index) =>
            encodeSessionEventEnvelope({
                kind: "session.event.v2",
                events: [
                    {
                        eventId: `${sessionId}-chunk-${index}`,
                        position: String(index),
                        recordedAt: "2026-10-12T00:00:00.000Z",
                        sessionGenerationId: `${sessionId}-generation`,
                        sessionId,
                        type: "acp",
                        payload: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `chunk-${index};` },
                        },
                    },
                ],
            }),
        );
        await recordThroughRelay(projectId, runtimeId, messages);

        const history = await json(
            await worker.request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/projects/${projectId}/recording/sessions/${sessionId}/events?runtimeId=${runtimeId}`,
                { headers: { authorization: `Bearer ${credential}` } },
                environment,
            ),
            200,
        );
        const recorded = decodeSessionRecordingHistory(JSON.stringify(history)).events.map((event) => event.eventId);
        expect(recorded).toEqual(Array.from({ length: chunkCount }, (_, index) => `${sessionId}-chunk-${index}`));
    });
});
