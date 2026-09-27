import type { SessionMessage } from "./session-presentation.ts";

export type SessionActivityState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly attempt: AssistantAttempt; readonly commandId: string }
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

export function startSessionWork(event: {
    readonly commandId: string;
    readonly attempt: AssistantAttempt;
}): SessionActivityState {
    return { attempt: event.attempt, commandId: event.commandId, kind: "working" };
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
