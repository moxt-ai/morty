import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeSessionPromptCommand,
    encodeCommittedSessionEvent,
    RUNTIME_WORKSPACE_BINDING_ID,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_COMMITTED_KIND,
} from "@moxt-ai/mobius-protocol";
import { WebSocketPair } from "miniflare";
import { expect, test } from "vitest";
import { runAutomatedRuntimeTurn } from "../src/gateway/automated-runtime-turn.ts";

test("Given a connected Runtime, When Slack sends a Turn, Then the native Agent receives it and Slack sees the reply", async () => {
    const sockets = new WebSocketPair();
    const chat = sockets[0];
    const runtime = sockets[1];
    chat.accept();
    runtime.accept();
    const received = new Promise<ReturnType<typeof decodeSessionPromptCommand>>((resolve) => {
        runtime.addEventListener("message", (event) => {
            const command = decodeSessionPromptCommand(String(event.data));
            resolve(command);
            const sendEvent = (payload: object) => {
                runtime.send(
                    encodeCommittedSessionEvent({
                        kind: SESSION_EVENT_COMMITTED_KIND,
                        payload: JSON.stringify(payload),
                        sessionId: command.sessionId,
                    }),
                );
            };
            sendEvent({
                commandId: command.commandId,
                epoch: command.commandId,
                kind: AGENT_MESSAGE_DELTA_KIND,
                messageId: "message_1",
                sequence: 1,
                sessionId: command.sessionId,
                text: "Hello from Claude Code",
            });
            sendEvent({
                commandId: command.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: command.sessionId,
                stopReason: "end_turn",
            });
        });
    });
    const result = await runAutomatedRuntimeTurn(
        chat,
        { agentRef: "claude" },
        "native_session_1",
        { commandId: "slack_event_1", prompt: "Hello", instructions: "Be concise" },
        new AbortController().signal,
    );
    expect(await received).toMatchObject({
        agentId: "claude",
        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
        sessionId: "native_session_1",
        prompt: "Hello",
        resources: [{ text: "Be concise" }],
    });
    expect(result).toEqual({ text: "Hello from Claude Code", stopReason: "end_turn" });
    chat.close(1000, "Test complete");
    runtime.close(1000, "Test complete");
});
