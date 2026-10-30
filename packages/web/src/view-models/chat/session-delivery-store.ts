import { MobiusApiError, MobiusCancellationError, type MobiusClient, type PromptAttachment } from "@moxt-ai/mobius-sdk";
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
    readonly attachments:
        | { readonly kind: "local"; readonly values: readonly ComposerAttachment[] }
        | { readonly kind: "uploaded"; readonly values: readonly PromptAttachment[] };
    readonly commandId: string;
    readonly content: string;
}
export type Journal = {
    /** Original local files are kept only in memory; the request already owns uploaded references. */
    readonly attachments: readonly ComposerAttachment[] | null;
    readonly commandId: string;
    readonly request: Omit<SubmitRequest, "idempotencyKey" | "disposition" | "targetCommandId"> & DeliveryTarget;
};
export function journalMessage(journal: Journal): SubmittedMessage {
    return {
        commandId: journal.commandId,
        content: journal.request.content,
        attachments:
            journal.attachments === null
                ? { kind: "uploaded", values: journal.request.attachments }
                : { kind: "local", values: journal.attachments },
        target:
            journal.request.disposition === "queue"
                ? { disposition: "queue", targetCommandId: journal.request.targetCommandId }
                : { disposition: "reject", targetCommandId: "" },
    };
}

export function deliveryMessagePresentation(message: SubmittedMessage) {
    return {
        ...message,
        displayPrompt:
            message.content.trim() ||
            message.attachments.values
                .filter((attachment) => attachment.uri !== "morty://bot/instructions")
                .map((attachment) => attachment.name)
                .join(", "),
        attachments: message.attachments.kind === "local" ? message.attachments.values : [],
        attachmentLabels:
            message.attachments.kind === "uploaded"
                ? message.attachments.values
                      .filter((attachment) => attachment.uri !== "morty://bot/instructions")
                      .map((attachment) => ({ name: attachment.name, uri: attachment.uri }))
                : [],
    };
}

type DeliveryState =
    | { readonly kind: "idle" }
    | { readonly kind: "preparing"; readonly message: SubmittedMessage }
    | { readonly kind: "preparation-failed"; readonly message: SubmittedMessage; readonly error: string }
    | { readonly kind: "submitting"; readonly journal: Journal; readonly confirmation: "unknown" | "delivered" }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly message: string; readonly journal: Journal };

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    /** Accepted prompts waiting for the Runtime's user-message history, independent of the next submission. */
    readonly confirmedMessages: readonly SubmittedMessage[];
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
    readonly pendingSubmission: Omit<Journal, "attachments"> | null;
    /** Writes the frozen request before it can leave the browser; failure prevents submission. */
    readonly pendingSubmissionChanged: (journal: Omit<Journal, "attachments"> | null) => void;
    /** Persists the unsent message's text, or clears it with null. */
    readonly unsentMessageChanged: (content: string | null) => void;
}) => {
    type Update = { readonly state: DeliveryState; readonly confirmedMessages?: readonly SubmittedMessage[] };
    const confirm = (journal: Journal, set: (update: Update) => void, get: () => SessionDeliveryStore): void => {
        set({
            state: { kind: "idle" },
            confirmedMessages: [
                ...get().confirmedMessages.filter((message) => message.commandId !== journal.commandId),
                journalMessage(journal),
            ],
        });
    };
    const send = async (
        journal: Journal,
        submit: SubmitTurn,
        signal: AbortSignal,
        set: (state: Update) => void,
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
            confirm(journal, set, get);
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
                confirm(journal, set, get);
                return { kind: "delivered" };
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return { kind: "delivery-unknown" };
        }
    };
    return createStore<SessionDeliveryStore>()((setState, get) => {
        const set = (update: Update): void => {
            const state = update.state;
            options.pendingSubmissionChanged(
                state.kind === "submitting" || state.kind === "delivery-unknown"
                    ? { commandId: state.journal.commandId, request: state.journal.request }
                    : null,
            );
            options.unsentMessageChanged(unsentContent(state));
            setState(update);
        };
        return {
            state:
                options.pendingSubmission === null
                    ? { kind: "idle" }
                    : { kind: "delivery-unknown", journal: { ...options.pendingSubmission, attachments: null } },
            confirmedMessages: [],
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
                    if (state.confirmation === "delivered") {
                        set({ state: { kind: "idle" } });
                    } else {
                        set({ state: { kind: "delivery-unknown", journal: state.journal } });
                    }
                }
            },
            messagesObserved: (commandIds) => {
                setState({
                    confirmedMessages: get().confirmedMessages.filter(
                        (message) => !commandIds.includes(message.commandId),
                    ),
                });
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
