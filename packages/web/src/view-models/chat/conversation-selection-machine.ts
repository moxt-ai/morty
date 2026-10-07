import type { OpenMobiusSession } from "./open-session.ts";

type SelectedConversationTarget =
    | { readonly kind: "conversation"; readonly conversationId: string }
    | { readonly kind: "session"; readonly sessionId: string };

export type ConversationTarget =
    | SelectedConversationTarget
    | {
          readonly kind: "continue";
          readonly action: "fork" | "import";
          readonly harness: string;
          readonly sessionId: string;
      };

export type ConversationSelectionState =
    | { readonly kind: "draft"; readonly key: string }
    | { readonly kind: "loading"; readonly target: ConversationTarget }
    | { readonly kind: "ready"; readonly session: OpenMobiusSession; readonly target: SelectedConversationTarget }
    | { readonly kind: "failed"; readonly message: string; readonly target: ConversationTarget };

export type ConversationSelectionEvent =
    | { readonly kind: "draft-selected"; readonly key: string }
    | { readonly kind: "target-selected"; readonly target: ConversationTarget }
    | {
          readonly kind: "session-loaded";
          readonly session: OpenMobiusSession;
          readonly target: SelectedConversationTarget;
      }
    | { readonly kind: "session-load-failed"; readonly message: string; readonly target: ConversationTarget }
    | { readonly kind: "retry-requested" }
    | {
          readonly kind: "continued-session-loaded";
          readonly session: OpenMobiusSession;
          readonly target: ConversationTarget;
      }
    | { readonly kind: "conversation-created"; readonly conversationId: string; readonly session: OpenMobiusSession };

function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    switch (left.kind) {
        case "conversation":
            return right.kind === "conversation" && left.conversationId === right.conversationId;
        case "session":
            return right.kind === "session" && left.sessionId === right.sessionId;
        case "continue":
            return (
                right.kind === "continue" &&
                left.action === right.action &&
                left.harness === right.harness &&
                left.sessionId === right.sessionId
            );
    }
}

export function transitionConversationSelection(
    state: ConversationSelectionState,
    event: ConversationSelectionEvent,
): ConversationSelectionState {
    switch (event.kind) {
        case "draft-selected":
            return { key: event.key, kind: "draft" };
        case "target-selected":
            return { kind: "loading", target: event.target };
        case "session-loaded":
            return state.kind === "loading" && sameTarget(state.target, event.target)
                ? { kind: "ready", session: event.session, target: event.target }
                : state;
        case "session-load-failed":
            return state.kind === "loading" && sameTarget(state.target, event.target)
                ? { kind: "failed", message: event.message, target: event.target }
                : state;
        case "retry-requested":
            return state.kind === "failed" ? { kind: "loading", target: state.target } : state;
        case "continued-session-loaded":
            return state.kind === "loading" &&
                state.target.kind === "continue" &&
                sameTarget(state.target, event.target)
                ? {
                      kind: "ready",
                      session: event.session,
                      target: { kind: "session", sessionId: event.session.result.ready.sessionId },
                  }
                : state;
        case "conversation-created":
            return state.kind === "draft"
                ? {
                      kind: "ready",
                      session: event.session,
                      target: { conversationId: event.conversationId, kind: "conversation" },
                  }
                : state;
    }
}

export function selectedConversationId(state: ConversationSelectionState): string {
    if (state.kind === "draft" || state.target.kind === "continue") {
        return "";
    }
    return state.target.kind === "conversation" ? state.target.conversationId : state.target.sessionId;
}
