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
export type Journal = {
    readonly attachments: readonly ComposerAttachment[];
    readonly commandId: string;
    readonly displayPrompt: string;
    readonly request: Omit<SubmitRequest, "idempotencyKey">;
};
type DeliveryState =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly journal: Journal; readonly confirmation: "unknown" | "delivered" }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly message: string };

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    readonly discardUnknown: () => string | null;
    readonly dismissFailure: () => void;
    /** Losing an attempt's connection does not discard its submitted intent. */
    readonly submissionInterrupted: () => void;
    readonly reconcile: (commandIds: readonly string[]) => void;
    readonly submit: (journal: Journal, submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome>;
    readonly retry: (submit: SubmitTurn, signal: AbortSignal) => Promise<SubmissionOutcome | null>;
}

function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        (cause instanceof MobiusApiError && cause.status >= 400 && cause.status < 500) ||
        (cause instanceof CloudApiError && cause.status !== null && cause.status >= 400 && cause.status < 500)
    );
}

/** The Session owns delivery; each attempt borrows the currently connected pane's submit port. */
export const createSessionDeliveryStore = () => {
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
            set({ state: { kind: "idle" } });
            return { kind: "accepted", turn: accepted };
        } catch (cause) {
            if (signal.aborted || cause instanceof MobiusCancellationError) {
                throw cause;
            }
            if (isAuthoritativeFailure(cause)) {
                set({
                    state: {
                        kind: "failed",
                        message: formatError(cause, "The message was rejected."),
                    },
                });
                return { kind: "rejected" };
            }
            const state = get().state;
            if (state.kind === "submitting" && state.confirmation === "delivered") {
                set({ state: { kind: "idle" } });
                return { kind: "delivered" };
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return { kind: "delivery-unknown" };
        }
    };
    return createStore<SessionDeliveryStore>()((set, get) => ({
        state: { kind: "idle" },
        discardUnknown: () => {
            const state = get().state;
            if (state.kind !== "delivery-unknown") {
                return null;
            }
            set({ state: { kind: "idle" } });
            return state.journal.commandId;
        },
        dismissFailure: () => {
            if (get().state.kind === "failed") {
                set({ state: { kind: "idle" } });
            }
        },
        submissionInterrupted: () => {
            const state = get().state;
            if (state.kind === "submitting") {
                set({
                    state:
                        state.confirmation === "delivered"
                            ? { kind: "idle" }
                            : { kind: "delivery-unknown", journal: state.journal },
                });
            }
        },
        reconcile: (commandIds) => {
            const state = get().state;
            // An in-flight request owns the disabled composer until it settles;
            // a live event must not expose the submitted draft to another send.
            if (state.kind === "submitting" && commandIds.includes(state.journal.commandId)) {
                set({ state: { ...state, confirmation: "delivered" } });
            }
            if (state.kind === "delivery-unknown" && commandIds.includes(state.journal.commandId)) {
                set({ state: { kind: "idle" } });
            }
        },
        submit: async (journal, submit, signal) => await send(journal, submit, signal, set, get),
        retry: async (submit, signal) => {
            const state = get().state;
            return state.kind === "delivery-unknown" ? await send(state.journal, submit, signal, set, get) : null;
        },
    }));
};
