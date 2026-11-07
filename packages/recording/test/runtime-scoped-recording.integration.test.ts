import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encodeSessionRecordingWrite, type SessionLiveEvent } from "@morty-build/client/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecordingStorage } from "../src/storage/session-recording-storage.ts";
import { createRecordingWorker } from "../src/worker.ts";

const worker = createRecordingWorker();
const projectId = "scoped-project";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

function event(sessionId: string, position: number, text: string): SessionLiveEvent {
    return {
        sessionId,
        eventId: `${sessionId}-${text}-${position}`,
        position: String(position),
        sessionGenerationId: `${text}-generation`,
        recordedAt: "2026-10-30T00:00:00.000Z",
        type: "acp",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    };
}

function batch(runtimeId: string, events: readonly SessionLiveEvent[]): string {
    return encodeSessionRecordingWrite({ projectId, runtimeId, envelope: { kind: "session.event.v2", events } });
}

async function record(runtimeId: string, events: readonly SessionLiveEvent[]) {
    const response = await worker.fetch(
        new Request("https://recording.test/v1/session-event-batches", {
            method: "POST",
            body: batch(runtimeId, events),
        }),
        env,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { readonly results: readonly { readonly kind: string }[] }).results;
}

async function history(runtimeId: string, sessionId: string): Promise<readonly string[]> {
    const response = await worker.fetch(
        new Request(
            `https://recording.test/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/events`,
        ),
        env,
    );
    expect(response.status).toBe(200);
    const recorded = (await response.json()) as { readonly events: readonly SessionLiveEvent[] };
    return recorded.events.map((item) => item.eventId);
}

describe("Recording per Runtime", () => {
    it("Given two Runtimes continuing one native Session, When both record it, Then each reads back only its own history", async () => {
        const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
        const first = event(sessionId, 1, "first");
        const second = event(sessionId, 1, "second");

        expect(await record("runtime-first", [first])).toEqual([{ sessionId, kind: "recorded" }]);
        expect(await record("runtime-second", [second])).toEqual([{ sessionId, kind: "recorded" }]);

        expect(await history("runtime-first", sessionId)).toEqual([first.eventId]);
        expect(await history("runtime-second", sessionId)).toEqual([second.eventId]);
    });

    it("Given retained history in an old Session object, When the launch Runtime records the same Session, Then only current Runtime-scoped history is served and retained data stays untouched", async () => {
        const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        const earlier = event(sessionId, 1, "earlier");
        const later = event(sessionId, 2, "earlier");
        const other = event(sessionId, 1, "other");
        // An earlier deployment kept the Session's only history in an object addressed by Project and Session.
        const retained = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(retained, (_instance, state) => {
            const stored = new SessionRecordingStorage(state.storage);
            expect(
                stored.append(
                    {
                        projectId,
                        runtimeId: "runtime-owner",
                        envelope: { kind: "session.event.v2", events: [earlier] },
                    },
                    { events: 1, operations: [] },
                ),
            ).toEqual({ kind: "recorded" });
        });

        expect(await record("runtime-owner", [later])).toEqual([{ sessionId, kind: "recorded" }]);
        expect(await record("runtime-other", [other])).toEqual([{ sessionId, kind: "recorded" }]);

        expect(await history("runtime-owner", sessionId)).toEqual([later.eventId]);
        expect(await history("runtime-other", sessionId)).toEqual([other.eventId]);
        await runInDurableObject(retained, (_instance, state) => {
            expect(
                state.storage.sql.exec("SELECT count(*) AS count FROM recorded_session_events_v2").one()["count"],
            ).toBe(1);
        });
        const oldOwnerRoute = await retained.fetch(new Request("https://legacy-recording.internal/owner"));
        expect(oldOwnerRoute.status).toBe(400);
    });
});
