import type { ChatAccess } from "../../services/chat/bot-chat-api.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import type { UnconfirmedSubmission } from "./session-delivery-store.ts";

export interface QueuedDraftMessage {
    readonly attachments: readonly ComposerAttachment[];
    readonly commandId: string;
    readonly content: string;
    readonly summary: string;
}

export type ConversationCreationState =
    | { readonly kind: "draft" }
    | { readonly kind: "session-creating"; readonly message: QueuedDraftMessage }
    | {
          readonly kind: "session-create-failed";
          readonly error: string;
          readonly message: QueuedDraftMessage;
      }
    | {
          readonly kind: "draft-message-sending";
          readonly access: ChatAccess;
          readonly message: QueuedDraftMessage;
      }
    | {
          readonly kind: "draft-message-send-failed";
          readonly access: ChatAccess;
          readonly error: string;
          readonly message: QueuedDraftMessage;
      }
    | {
          readonly kind: "initial-message-pending";
          readonly conversationId: string;
          readonly message: QueuedDraftMessage;
          readonly session: OpenMobiusSession;
      }
    | {
          /**
           * The pane submitted the queued first message but the service never
           * confirmed it, so the user must retry or discard it. Distinct from
           * "pending" so a remount never auto-submits an unconfirmed message.
           */
          readonly kind: "initial-message-unconfirmed";
          readonly conversationId: string;
          /**
           * The exact submission the previous pane issued. A remount adopts it
           * as the pane's delivery journal so the user can retry or discard it,
           * and nothing is resubmitted without that decision.
           */
          readonly journal: UnconfirmedSubmission;
          readonly message: QueuedDraftMessage;
          readonly session: OpenMobiusSession;
      };

export type ConversationCreationEvent =
    | { readonly kind: "reset" }
    | { readonly kind: "draft-message-queued"; readonly message: QueuedDraftMessage }
    | { readonly kind: "session-created"; readonly commandId: string; readonly access: ChatAccess }
    | { readonly kind: "session-create-failed"; readonly commandId: string; readonly error: string }
    | { readonly kind: "draft-message-retry-requested"; readonly commandId: string }
    | { readonly kind: "initial-message-delivered"; readonly conversationId: string }
    | {
          readonly kind: "initial-message-discarded";
          readonly commandId: string;
          readonly conversationId: string;
      }
    | {
          readonly kind: "initial-message-pending";
          readonly commandId: string;
          readonly conversationId: string;
          readonly session: OpenMobiusSession;
      }
    | {
          readonly kind: "initial-message-unconfirmed";
          readonly journal: UnconfirmedSubmission;
      }
    | { readonly kind: "draft-message-send-failed"; readonly commandId: string; readonly error: string };

function isCurrentMessage(state: ConversationCreationState, commandId: string): boolean {
    switch (state.kind) {
        case "draft":
        case "initial-message-pending":
        case "initial-message-unconfirmed":
            return false;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
        case "draft-message-send-failed":
            return state.message.commandId === commandId;
    }
}

export function transitionConversationCreation(
    state: ConversationCreationState,
    event: ConversationCreationEvent,
): ConversationCreationState {
    switch (event.kind) {
        case "reset":
            return { kind: "draft" };
        case "draft-message-queued":
            switch (state.kind) {
                case "draft":
                case "session-create-failed":
                    return { kind: "session-creating", message: event.message };
                case "session-creating":
                case "draft-message-sending":
                case "draft-message-send-failed":
                case "initial-message-pending":
                case "initial-message-unconfirmed":
                    return state;
            }
            return state;
        case "session-created":
            return state.kind === "session-creating" && isCurrentMessage(state, event.commandId)
                ? { access: event.access, kind: "draft-message-sending", message: state.message }
                : state;
        case "session-create-failed":
            return state.kind === "session-creating" && isCurrentMessage(state, event.commandId)
                ? { error: event.error, kind: "session-create-failed", message: state.message }
                : state;
        case "draft-message-retry-requested":
            return state.kind === "draft-message-send-failed" && isCurrentMessage(state, event.commandId)
                ? { access: state.access, kind: "draft-message-sending", message: state.message }
                : state;
        case "initial-message-delivered":
            // The pane that opened this conversation has sent the queued first
            // message; a later view must not send it again.
            return (state.kind === "initial-message-pending" || state.kind === "initial-message-unconfirmed") &&
                state.conversationId === event.conversationId
                ? { kind: "draft" }
                : state;
        case "initial-message-discarded":
            // The user removed the queued first message after an uncertain
            // delivery. Drop the recovery copy so a remount cannot submit a
            // message the user explicitly discarded; the pane's own discard
            // already ended its retry path, so both copies must agree.
            return (state.kind === "initial-message-pending" || state.kind === "initial-message-unconfirmed") &&
                state.conversationId === event.conversationId &&
                state.message.commandId === event.commandId
                ? { kind: "draft" }
                : state;
        case "initial-message-pending":
            return state.kind === "draft-message-sending" && isCurrentMessage(state, event.commandId)
                ? {
                      conversationId: event.conversationId,
                      kind: "initial-message-pending",
                      message: state.message,
                      session: event.session,
                  }
                : state;
        case "initial-message-unconfirmed":
            // The pane could not confirm the submission. Keep the message so
            // the user can retry it, but as a state that never auto-sends.
            return state.kind === "initial-message-pending" && state.message.commandId === event.journal.commandId
                ? {
                      conversationId: state.conversationId,
                      journal: event.journal,
                      kind: "initial-message-unconfirmed",
                      message: state.message,
                      session: state.session,
                  }
                : state;
        case "draft-message-send-failed":
            return state.kind === "draft-message-sending" && isCurrentMessage(state, event.commandId)
                ? {
                      access: state.access,
                      error: event.error,
                      kind: "draft-message-send-failed",
                      message: state.message,
                  }
                : state;
    }
}

export function queuedDraftMessage(state: ConversationCreationState): QueuedDraftMessage | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "initial-message-pending":
        case "initial-message-unconfirmed":
            return state.message;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
        case "draft-message-send-failed":
            return state.message;
    }
}

export function conversationCreationStatus(state: ConversationCreationState): string | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "initial-message-pending":
            return null;
        case "initial-message-unconfirmed":
            return "Message delivery was not confirmed";
        case "session-creating":
            return "Session creating";
        case "session-create-failed":
            return "Session creation failed";
        case "draft-message-sending":
            return "Sending message";
        case "draft-message-send-failed":
            return "Message failed to send";
    }
}

export function conversationCreationError(state: ConversationCreationState): string {
    switch (state.kind) {
        case "session-create-failed":
        case "draft-message-send-failed":
            return state.error;
        case "draft":
        case "session-creating":
        case "draft-message-sending":
        case "initial-message-pending":
        case "initial-message-unconfirmed":
            return "";
    }
}

export function conversationCreationBusy(state: ConversationCreationState): boolean {
    switch (state.kind) {
        case "session-creating":
        case "draft-message-sending":
            return true;
        case "draft":
        case "session-create-failed":
        case "draft-message-send-failed":
        case "initial-message-pending":
        case "initial-message-unconfirmed":
            return false;
    }
}

export function conversationComposerLocked(state: ConversationCreationState): boolean {
    switch (state.kind) {
        case "draft":
        case "initial-message-pending":
        case "initial-message-unconfirmed":
            return false;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
        case "draft-message-send-failed":
            return true;
    }
}
