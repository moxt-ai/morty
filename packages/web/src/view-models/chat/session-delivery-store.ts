import { MobiusApiError, MobiusCancellationError, type MobiusClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { formatError } from "../format-error.ts";

type SubmitRequest = Parameters<MobiusClient["turns"]["submit"]>[1];
type AcceptedTurn = { readonly turnId: string };
type SubmitTurn = (request: SubmitRequest, signal: AbortSignal) => Promise<AcceptedTurn>;
type SubmissionOutcome =
    | { readonly kind: "accepted"; readonly turn: AcceptedTurn }
    /** The request failed, but the service had already shown it has the command. */
    | { readonly kind: "delivered" }
    | { readonly kind: "rejected" }
    | { readonly kind: "delivery-unknown" };
export type DeliveryTarget =
    | { readonly disposition: "reject"; readonly targetCommandId: "" }
    | { readonly disposition: "queue"; readonly targetCommandId: string };

export interface SubmittedMessage {
    readonly target: DeliveryTarget;
    readonly attachments: readonly ComposerAttachment[];
    readonly commandId: string;
    readonly content: string;
}
export type Journal = {
    readonly attachments: readonly ComposerAttachment[];
    readonly commandId: string;
    readonly displayPrompt: string;
    readonly request: Omit<SubmitRequest, "idempotencyKey" | "disposition" | "targetCommandId"> & DeliveryTarget;
};
export function journalMessage(journal: Journal): SubmittedMessage {
    return {
        commandId: journal.commandId,
        content: journal.request.content,
        attachments: journal.attachments,
        target:
            journal.request.disposition === "queue"
                ? { disposition: "queue", targetCommandId: journal.request.targetCommandId }
                : { disposition: "reject", targetCommandId: "" },
    };
}

type DeliveryState =
    | { readonly kind: "idle" }
    | { readonly kind: "preparing"; readonly message: SubmittedMessage }
    | { readonly kind: "preparation-failed"; readonly message: SubmittedMessage; readonly error: string }
    | { readonly kind: "submitting"; readonly journal: Journal; readonly confirmation: "unknown" | "delivered" }
    | { readonly kind: "confirmed"; readonly journal: Journal }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly message: string; readonly journal: Journal };

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    readonly discardUnknown: () => string | null;
    readonly prepare: (message: SubmittedMessage) => void;
    readonly preparationFailed: (message: SubmittedMessage, error: string) => void;
    readonly takeFailedMessage: () => SubmittedMessage | null;
    /** Losing an attempt's connection does not discard its submitted intent. */
    readonly submissionInterrupted: () => void;
    readonly reconcile: (commandIds: readonly string[]) => void;
    readonly messagesObserved: (commandIds: readonly string[]) => void;
    readonly submit: (journal: Journal, submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome>;
    readonly retry: (submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome | null>;
}

/**
 * Text the Runtime has not taken: a reload returns it to the composer. A message that may have been delivered is
 * not unsent, because sending it again under a new identity could run it twice.
 */
function unsentContent(state: DeliveryState): string | null {
    switch (state.kind) {
        case "preparing":
        case "preparation-failed":
            return state.message.content.trim() === "" ? null : state.message.content;
        case "failed":
            return state.journal.request.content === "" ? null : state.journal.request.content;
        case "idle":
        case "submitting":
        case "confirmed":
        case "delivery-unknown":
            return null;
        default:
            return state satisfies never;
    }
}

/** Joins a message returned to the composer with the draft written after it. */
export function prependToDraft(content: string, draft: string): string {
    return draft.length === 0 ? content : content.length === 0 ? draft : `${content}\n\n${draft}`;
}

function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        (cause instanceof MobiusApiError && cause.status >= 400 && cause.status < 500) ||
        (cause instanceof CloudApiError && cause.status !== null && cause.status >= 400 && cause.status < 500)
    );
}

/** The Session owns delivery; each attempt borrows the currently connected pane's submit port. */
export const createSessionDeliveryStore = (options: {
    /** Persists the unsent message's text, or clears it with null. */
    readonly unsentMessageChanged: (content: string | null) => void;
}) => {
    const send = async (
        journal: Journal,
        submit: SubmitTurn,
        signal: AbortSignal,
        set: (state: Pick<SessionDeliveryStore, "state">) => void,
        get: () => SessionDeliveryStore,
    ): Promise<SubmissionOutcome> => {
        set({ state: { kind: "submitting", journal, confirmation: "unknown" } });
        try {
            const accepted = await submit(
                {
                    ...journal.request,
                    idempotencyKey: journal.commandId,
                },
                signal,
            );
            signal.throwIfAborted();
            set({ state: { kind: "confirmed", journal } });
            return { kind: "accepted", turn: accepted };
        } catch (cause) {
            if (signal.aborted || cause instanceof MobiusCancellationError) {
                throw cause;
            }
            if (isAuthoritativeFailure(cause)) {
                set({
                    state: {
                        kind: "failed",
                        journal,
                        message: formatError(cause, "The message was rejected."),
                    },
                });
                return { kind: "rejected" };
            }
            const state = get().state;
            if (state.kind === "submitting" && state.confirmation === "delivered") {
                set({ state: { kind: "confirmed", journal } });
                return { kind: "delivered" };
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return { kind: "delivery-unknown" };
        }
    };
    return createStore<SessionDeliveryStore>()((setState, get) => {
        const set = (update: Pick<SessionDeliveryStore, "state">): void => {
            setState(update);
            options.unsentMessageChanged(unsentContent(update.state));
        };
        return {
            state: { kind: "idle" },
            discardUnknown: () => {
                const state = get().state;
                if (state.kind !== "delivery-unknown") {
                    return null;
                }
                set({ state: { kind: "idle" } });
                return state.journal.commandId;
            },
            prepare: (message) => set({ state: { kind: "preparing", message } }),
            preparationFailed: (message, error) => set({ state: { kind: "preparation-failed", message, error } }),
            takeFailedMessage: () => {
                const state = get().state;
                const message =
                    state.kind === "preparation-failed"
                        ? state.message
                        : state.kind === "failed"
                          ? journalMessage(state.journal)
                          : null;
                if (message !== null) {
                    set({ state: { kind: "idle" } });
                }
                return message;
            },
            submissionInterrupted: () => {
                const state = get().state;
                if (state.kind === "preparing") {
                    set({
                        state: {
                            kind: "preparation-failed",
                            message: state.message,
                            error: "Message preparation was interrupted. Retry when connected.",
                        },
                    });
                } else if (state.kind === "submitting") {
                    set({
                        state:
                            state.confirmation === "delivered"
                                ? { kind: "idle" }
                                : { kind: "delivery-unknown", journal: state.journal },
                    });
                }
            },
            messagesObserved: (commandIds) => {
                const state = get().state;
                if (state.kind === "confirmed" && commandIds.includes(state.journal.commandId)) {
                    set({ state: { kind: "idle" } });
                }
            },
            reconcile: (commandIds) => {
                const state = get().state;
                // Confirmation belongs to the submitted message, independently of the next editable draft.
                if (state.kind === "submitting" && commandIds.includes(state.journal.commandId)) {
                    set({ state: { ...state, confirmation: "delivered" } });
                }
                if (state.kind === "delivery-unknown" && commandIds.includes(state.journal.commandId)) {
                    set({ state: { kind: "idle" } });
                }
            },
            submit: async (journal, submit, signal) => await send(journal, submit, signal, set, get),
            // Only an unknown delivery repeats its identity; the Runtime never runs a rejected command identity again.
            retry: async (submit, signal) => {
                const state = get().state;
                return state.kind === "delivery-unknown" ? await send(state.journal, submit, signal, set, get) : null;
            },
        };
    });
};
