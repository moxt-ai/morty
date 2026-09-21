import type { SessionMessage } from "./session-presentation.ts";

export type SessionActivityState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly commandId: string; readonly messageId: string }
    | { readonly kind: "failed"; readonly commandId: string | null; readonly message: string };

export type SessionActivityEvent =
    | { readonly kind: "work-completed"; readonly commandId: string }
    | { readonly kind: "work-failed"; readonly commandId: string; readonly message: string }
    | { readonly kind: "session-failed"; readonly message: string };

export function transitionSessionActivity(
    state: SessionActivityState,
    event: SessionActivityEvent,
): SessionActivityState {
    switch (event.kind) {
        case "work-completed":
            return state.kind === "working" && state.commandId === event.commandId ? { kind: "idle" } : state;
        case "work-failed":
            return state.kind === "working" && state.commandId === event.commandId
                ? { commandId: event.commandId, kind: "failed", message: event.message }
                : state;
        case "session-failed":
            return {
                commandId: state.kind === "working" ? state.commandId : null,
                kind: "failed",
                message: event.message,
            };
    }
}

type AssistantAttempt = Extract<SessionMessage, { readonly role: "assistant" }>["attempt"];

export function startSessionWork(
    state: { readonly activity: SessionActivityState; readonly messages: readonly SessionMessage[] },
    event: { readonly commandId: string; readonly attempt: AssistantAttempt },
): { readonly activity: SessionActivityState; readonly messages: readonly SessionMessage[] } {
    const target = state.messages.findLastIndex(
        (message) => message.role === "assistant" && message.commandId === event.commandId,
    );
    const messages =
        target < 0
            ? [
                  ...state.messages,
                  {
                      activityIds: [],
                      attempt: event.attempt,
                      commandId: event.commandId,
                      contents: [],
                      id: `${event.commandId}-reply`,
                      role: "assistant" as const,
                      text: "",
                  },
              ]
            : event.attempt === null
              ? state.messages
              : state.messages.map((message, index) =>
                    index === target && message.role === "assistant" ? { ...message, attempt: event.attempt } : message,
                );
    const messageId = target < 0 ? `${event.commandId}-reply` : state.messages[target]?.id;
    if (messageId === undefined) {
        throw new Error("The active assistant response target is unavailable.");
    }
    return { activity: { commandId: event.commandId, kind: "working", messageId }, messages };
}

export function workingCommandId(state: SessionActivityState): string | null {
    switch (state.kind) {
        case "idle":
        case "failed":
            return null;
        case "working":
            return state.commandId;
    }
}
