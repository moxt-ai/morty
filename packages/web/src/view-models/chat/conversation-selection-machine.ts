import { type OpenMobiusSession, type SelectedMobiusSession, selectedSession } from "./open-session.ts";

type ConversationTarget =
    | { readonly kind: "conversation"; readonly conversationId: string }
    | { readonly kind: "session"; readonly sessionId: string };

export type ConversationSelectionState =
    | { readonly kind: "draft"; readonly key: string }
    /** A selected target waiting for entry prerequisites; no session request is in flight. */
    | { readonly kind: "pending"; readonly target: ConversationTarget }
    | { readonly kind: "loading"; readonly target: ConversationTarget }
    | {
          readonly kind: "ready";
          readonly session: SelectedMobiusSession;
          readonly target: ConversationTarget;
      }
    | {
          readonly kind: "failed";
          readonly failure: "connection" | "runtime" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: ConversationTarget;
      };

export type ConversationSelectionEvent =
    | { readonly kind: "draft-selected"; readonly key: string }
    | { readonly kind: "target-selected"; readonly target: ConversationTarget }
    | { readonly kind: "session-load-started" }
    | {
          readonly kind: "session-loaded";
          readonly session: OpenMobiusSession;
          readonly target: ConversationTarget;
      }
    | {
          readonly kind: "session-load-failed";
          readonly failure: "connection" | "runtime" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: ConversationTarget;
      }
    | { readonly kind: "retry-requested" }
    | { readonly kind: "reload-requested" }
    | { readonly kind: "conversation-created"; readonly conversationId: string; readonly session: OpenMobiusSession };

function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
    return left.kind === "conversation"
        ? right.kind === "conversation" && left.conversationId === right.conversationId
        : right.kind === "session" && left.sessionId === right.sessionId;
}

export function transitionConversationSelection(
    state: ConversationSelectionState,
    event: ConversationSelectionEvent,
): ConversationSelectionState {
    switch (event.kind) {
        case "draft-selected":
            return { key: event.key, kind: "draft" };
        case "target-selected":
            return { kind: "pending", target: event.target };
        case "session-load-started":
            return state.kind === "pending" ? { kind: "loading", target: state.target } : state;
        case "session-loaded":
            return state.kind === "loading" && sameTarget(state.target, event.target)
                ? { kind: "ready", session: selectedSession(event.session), target: event.target }
                : state;
        case "session-load-failed":
            return (state.kind === "pending" || state.kind === "loading") && sameTarget(state.target, event.target)
                ? { kind: "failed", failure: event.failure, message: event.message, target: event.target }
                : state;
        case "retry-requested":
            return state.kind === "failed" ? { kind: "pending", target: state.target } : state;
        case "reload-requested":
            return state.kind === "ready" ? { kind: "loading", target: state.target } : state;
        case "conversation-created":
            return state.kind === "draft"
                ? {
                      kind: "ready",
                      session: selectedSession(event.session),
                      target: { conversationId: event.conversationId, kind: "conversation" },
                  }
                : state;
    }
}

export function selectedConversationId(state: ConversationSelectionState): string {
    if (state.kind === "draft") {
        return "";
    }
    return state.target.kind === "conversation" ? state.target.conversationId : state.target.sessionId;
}
