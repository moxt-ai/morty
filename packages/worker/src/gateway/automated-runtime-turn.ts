import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentMessageDeltaEvent,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeRecordedSessionEvent,
    decodeSessionCompletedEvent,
    decodeSessionFailedEvent,
    encodeSessionPromptCommand,
    RUNTIME_WORKSPACE_BINDING_ID,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { PlatformProjectError } from "../components/management/entity/platform-project.ts";

type RuntimeTurnSocket = EventTarget & {
    readonly send: (message: string) => void;
};

export async function runAutomatedRuntimeTurn(
    socket: RuntimeTurnSocket,
    selection: { readonly agentRef: string },
    sessionId: string,
    input: { readonly commandId: string; readonly prompt: string; readonly instructions: string },
    signal: AbortSignal,
): Promise<{ readonly text: string; readonly stopReason: string }> {
    signal.throwIfAborted();
    const command = encodeSessionPromptCommand({
        additionalDirectoryIds: [],
        agentId: selection.agentRef,
        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
        commandId: input.commandId,
        directoryId: "default",
        disposition: SessionPromptDisposition.Reject,
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: input.prompt,
        resources:
            input.instructions.trim().length === 0
                ? []
                : [
                      {
                          type: "embedded",
                          uri: "morty://bot/instructions",
                          name: "Bot instructions",
                          mimeType: "text/plain",
                          text: input.instructions,
                      },
                  ],
        sessionId,
        targetCommandId: "",
    });
    let text = "";
    return await new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onClose);
            signal.removeEventListener("abort", onAbort);
        };
        const fail = (error: unknown) => {
            cleanup();
            reject(error);
        };
        const onAbort = () => fail(signal.reason);
        const onClose = () =>
            fail(new PlatformProjectError("TURN_STREAM_INTERRUPTED", "The local Runtime disconnected.", 502));
        const onMessage = (event: Event) => {
            try {
                const data: unknown = Reflect.get(event, "data");
                if (typeof data !== "string") {
                    throw new PlatformProjectError(
                        "INVALID_RUNTIME_MESSAGE",
                        "The Runtime returned an invalid event.",
                        502,
                    );
                }
                if (decodeMessageKind(data) !== SESSION_EVENT_COMMITTED_KIND) {
                    return;
                }
                const committed = decodeCommittedSessionEvent(data);
                if (committed.sessionId !== sessionId) {
                    return;
                }
                const payload = decodeRecordedSessionEvent(committed.payload);
                if (payload.sessionId !== sessionId) {
                    throw new PlatformProjectError(
                        "INVALID_RUNTIME_MESSAGE",
                        "The Runtime returned an invalid event.",
                        502,
                    );
                }
                const kind = decodeMessageKind(committed.payload);
                if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    const delta = decodeAgentMessageDeltaEvent(committed.payload);
                    if (delta.commandId === input.commandId) {
                        text += delta.text;
                        if (text.length > 1_000_000) {
                            throw new PlatformProjectError(
                                "TURN_REPLY_TOO_LARGE",
                                "The Agent reply exceeded the Slack limit.",
                                502,
                            );
                        }
                    }
                } else if (kind === SESSION_COMPLETED_KIND) {
                    const completed = decodeSessionCompletedEvent(committed.payload);
                    if (completed.commandId === input.commandId) {
                        cleanup();
                        resolve({ text, stopReason: completed.stopReason });
                    }
                } else if (kind === SESSION_FAILED_KIND) {
                    const failed = decodeSessionFailedEvent(committed.payload);
                    if (failed.commandId === input.commandId) {
                        fail(new PlatformProjectError(failed.code, failed.message, 502));
                    }
                }
            } catch (error) {
                if (error instanceof PlatformProjectError) {
                    fail(error);
                    return;
                }
                fail(
                    new PlatformProjectError("INVALID_RUNTIME_MESSAGE", "The Runtime returned an invalid event.", 502, {
                        cause: error,
                    }),
                );
            }
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            signal.throwIfAborted();
            socket.send(command);
        } catch (error) {
            fail(
                new PlatformProjectError("RUNTIME_UNAVAILABLE", "The local Runtime could not receive the Turn.", 503, {
                    cause: error,
                }),
            );
        }
    });
}
