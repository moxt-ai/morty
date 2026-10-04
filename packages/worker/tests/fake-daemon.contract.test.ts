import * as p from "@moxt-ai/mobius-protocol";
import { FakeAgentDaemon } from "@moxt-ai/mobius-test/fake-daemon/peer";
import { expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";

function peer() {
    const messages: string[] = [];
    const daemon = new FakeAgentDaemon((message) => messages.push(message), { reply: mortyReply });
    const prompt = (commandId: string, text: string, disposition = "reject") =>
        daemon.receive(
            p.encodeSessionPromptCommand({
                kind: "session.prompt",
                sessionId: "session",
                commandId,
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "default",
                additionalDirectoryIds: [],
                prompt: text,
                images: [],
                resources: [],
                disposition,
                targetCommandId: disposition === "reject" ? "" : "active",
            }),
        );
    const events = () =>
        messages.flatMap((message) =>
            p.decodeMessageKind(message) === "session.event"
                ? [p.decodeRecordedSessionEvent(p.decodeSessionEventEnvelope(message).payload)]
                : [],
        );
    const active = () => {
        daemon.receive(
            p.encodeNativeSessionCommand({
                kind: "native.session.request",
                requestId: "read",
                sessionId: "session",
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "default",
                additionalDirectoryIds: [],
                action: "active-turn",
                targetSessionId: "session",
            }),
        );
        const encoded = messages.at(-1);
        if (encoded === undefined) {
            throw new Error("Missing reply");
        }
        const result = p.decodeNativeSessionResult(encoded);
        if (result.action !== "active-turn") {
            throw new Error("Expected active turn");
        }
        return result;
    };
    return { daemon, prompt, events, active, messages };
}

test("Given an active turn, When a client rejects overlap and cancels a queued prompt, Then the active turn remains and the queue is empty", () => {
    const client = peer();
    client.prompt("active", "wait for steering");
    client.prompt("rejected", "must not queue");
    expect(client.events()).toContainEqual(
        expect.objectContaining({ kind: "session.failed", commandId: "rejected", code: "session_busy" }),
    );
    client.prompt("queued", "next", "queue");
    client.daemon.receive(
        p.encodeSessionCancelCommand({ kind: "session.cancel", sessionId: "session", commandId: "queued" }),
    );
    expect(client.active()).toMatchObject({ queued: [], turn: { commandId: "active", state: "running" } });
    expect(client.events()).toContainEqual(
        expect.objectContaining({ kind: "session.completed", commandId: "queued", stopReason: "cancelled" }),
    );
});

test("Given a short active turn, When a viewer requests recovery, Then the complete turn fits in one snapshot", () => {
    const client = peer();
    client.prompt("active", "wait for steering");
    expect(client.active().turn).toMatchObject({
        hasOlder: false,
        messages: [
            { role: "user", text: "wait for steering" },
            { role: "assistant", text: "Waiting for steering" },
        ],
    });
});

test("Given two completed turns, When a viewer reads one recent history message, Then older commands are not declared covered", () => {
    const client = peer();
    client.prompt("first", "First");
    client.prompt("second", "Second");
    client.daemon.receive(
        p.encodeSessionLiveHistoryPageLoad({
            kind: "session.live-history.page.load",
            requestId: "history",
            sessionId: "session",
            agentId: "codex",
            bindingId: "workspace",
            directoryId: "default",
            additionalDirectoryIds: [],
            cursor: null,
            limit: 1,
        }),
    );
    const encoded = client.messages.at(-1);
    if (encoded === undefined) {
        throw new Error("Missing history reply");
    }
    const result = p.decodeSessionLiveHistoryPageLoaded(encoded);
    expect(result.page).toMatchObject({ status: "available", coveredCommandIds: [] });
});
