import {
    MobiusApiError,
    MobiusCancellationError,
    type MobiusClient,
    MobiusError,
    type PromptAttachment,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { formatError } from "../format-error.ts";

type SubmitRequest = Parameters<MobiusClient["turns"]["submit"]>[1];
type AcceptedTurn = { readonly turnId: string };
export type SubmitTurn = (request: SubmitRequest, signal: AbortSignal) => Promise<AcceptedTurn>;
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

/** Why a submission failed before the service accepted it; delivery is the one record of it. */
export type SubmissionFailure = { readonly code: string; readonly message: string };

export function submissionFailure(cause: unknown, fallback: string): SubmissionFailure {
    return { code: cause instanceof MobiusError ? cause.code : "", message: formatError(cause, fallback) };
}

export type DeliveryState =
    | { readonly kind: "idle" }
    /**
     * A message the Session holds until a connected pane prepares it: a new Session's first message, which its
     * delivery owns from the Session's creation, so no moment leaves it without a record a reload can return.
     */
    | { readonly kind: "awaiting-connection"; readonly message: SubmittedMessage }
    | { readonly kind: "preparing"; readonly message: SubmittedMessage }
    | { readonly kind: "preparation-failed"; readonly message: SubmittedMessage; readonly failure: SubmissionFailure }
    | { readonly kind: "submitting"; readonly journal: Journal; readonly confirmation: "unknown" | "delivered" }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly journal: Journal; readonly failure: SubmissionFailure };

/** The message of a submission that failed before the service accepted it, kept until it is retried or discarded. */
export function failedSubmission(
    state: DeliveryState,
): { readonly message: SubmittedMessage; readonly failure: SubmissionFailure } | null {
    switch (state.kind) {
        case "preparation-failed":
            return { message: state.message, failure: state.failure };
        case "failed":
            return { message: journalMessage(state.journal), failure: state.failure };
        case "idle":
        case "awaiting-connection":
        case "preparing":
        case "submitting":
        case "delivery-unknown":
            return null;
        default:
            return state satisfies never;
    }
}

/** The message the Session holds for its next connected pane to submit. */
export function awaitingMessage(state: DeliveryState): SubmittedMessage | null {
    return state.kind === "awaiting-connection" ? state.message : null;
}

/** The submitted intent and files have one owner through preparation, admission and queueing. */
export function deliveryMessages(
    delivery: Pick<SessionDeliveryStore, "state" | "acceptedMessages">,
): readonly SubmittedMessage[] {
    const state = delivery.state;
    switch (state.kind) {
        case "idle":
            return delivery.acceptedMessages;
        case "awaiting-connection":
        case "preparing":
        case "preparation-failed":
            return [...delivery.acceptedMessages, state.message];
        case "submitting":
        case "delivery-unknown":
        case "failed":
            return [...delivery.acceptedMessages, journalMessage(state.journal)];
        default:
            return state satisfies never;
    }
}

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    /** Accepted input retained until history owns its display and the queue no longer needs its local files. */
    readonly acceptedMessages: readonly SubmittedMessage[];
    readonly discardUnknown: () => void;
    /** Takes a new Session's first message, which a pane submits once it connects. */
    readonly awaitConnection: (message: SubmittedMessage) => void;
    readonly prepare: (message: SubmittedMessage) => void;
    readonly preparationFailed: (message: SubmittedMessage, failure: SubmissionFailure) => void;
    readonly takeFailedMessage: () => SubmittedMessage | null;
    /** Losing an attempt's connection does not discard its submitted intent. */
    readonly submissionInterrupted: () => void;
    readonly reconcile: (commandIds: readonly string[]) => void;
    /** Releases original input once history owns it or the Runtime confirms its withdrawal. */
    readonly releaseMessages: (commandIds: readonly string[]) => void;
    readonly submit: (journal: Journal, submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome>;
    readonly retry: (submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome | null>;
}

/**
 * Text the Runtime has not taken: a reload returns it to the composer. A message that may have been delivered is
 * not unsent, because sending it again under a new identity could run it twice.
 */
function unsentContent(state: DeliveryState): string | null {
    switch (state.kind) {
        case "awaiting-connection":
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

/** The delivery of no Session, for a view that follows the open Session's delivery when none is open. */
export const noSessionDelivery = createStore<Pick<SessionDeliveryStore, "state">>()(() => ({
    state: { kind: "idle" },
}));

/** The Session owns delivery; each attempt borrows the currently connected pane's submit port. */
export const createSessionDeliveryStore = (options: {
    readonly pendingSubmission: Omit<Journal, "attachments"> | null;
    /** Writes the frozen request before it can leave the browser; failure prevents submission. */
    readonly pendingSubmissionChanged: (journal: Omit<Journal, "attachments"> | null) => void;
    /** Persists the unsent message's text, or clears it with null. */
    readonly unsentMessageChanged: (content: string | null) => void;
}) => {
    type Update = { readonly state: DeliveryState; readonly acceptedMessages?: readonly SubmittedMessage[] };
    const confirm = (journal: Journal, set: (update: Update) => void, get: () => SessionDeliveryStore): void => {
        set({
            state: { kind: "idle" },
            acceptedMessages: [
                ...get().acceptedMessages.filter((message) => message.commandId !== journal.commandId),
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
                    state: { kind: "failed", journal, failure: submissionFailure(cause, "The message was rejected.") },
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
            acceptedMessages: [],
            discardUnknown: () => {
                if (get().state.kind === "delivery-unknown") {
                    set({ state: { kind: "idle" } });
                }
            },
            awaitConnection: (message) => set({ state: { kind: "awaiting-connection", message } }),
            prepare: (message) => set({ state: { kind: "preparing", message } }),
            preparationFailed: (message, failure) => set({ state: { kind: "preparation-failed", message, failure } }),
            takeFailedMessage: () => {
                const failed = failedSubmission(get().state);
                if (failed !== null) {
                    set({ state: { kind: "idle" } });
                }
                return failed?.message ?? null;
            },
            submissionInterrupted: () => {
                const state = get().state;
                if (state.kind === "preparing") {
                    set({
                        state: {
                            kind: "preparation-failed",
                            message: state.message,
                            failure: {
                                code: "",
                                message: "Message preparation was interrupted. Retry when connected.",
                            },
                        },
                    });
                } else if (state.kind === "submitting") {
                    if (state.confirmation === "delivered") {
                        if (state.journal.request.disposition === "queue") {
                            confirm(state.journal, set, get);
                        } else {
                            set({ state: { kind: "idle" } });
                        }
                    } else {
                        set({ state: { kind: "delivery-unknown", journal: state.journal } });
                    }
                }
            },
            releaseMessages: (commandIds) => {
                setState({
                    acceptedMessages: get().acceptedMessages.filter(
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
                    // Recovered history from released Runtimes may omit command identities. As before, their
                    // execution receipt owns a recovered immediate message; queue inputs still retain local files.
                    if (state.journal.request.disposition === "queue") {
                        confirm(state.journal, set, get);
                    } else {
                        set({ state: { kind: "idle" } });
                    }
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
