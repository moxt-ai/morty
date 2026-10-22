import { MobiusApiError, MobiusCancellationError, type MobiusClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { CloudApiError } from "../../services/management/management-api.ts";
import { formatError } from "../format-error.ts";

type SubmitRequest = Parameters<MobiusClient["turns"]["submit"]>[1];
export type AcceptedTurn = { readonly turnId: string };
type SubmissionOutcome =
    | { readonly kind: "accepted"; readonly turn: AcceptedTurn }
    | { readonly kind: "rejected" }
    | { readonly kind: "delivery-unknown" };
export type Journal = {
    readonly commandId: string;
    readonly displayPrompt: string;
    readonly request: Omit<SubmitRequest, "idempotencyKey">;
};
/** A Journal that can cross into the home store and back on remount. */
export type UnconfirmedSubmission = Journal;

type DeliveryState =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly journal: Journal }
    | { readonly kind: "delivery-unknown"; readonly journal: Journal }
    | { readonly kind: "failed"; readonly message: string };

export interface SessionDeliveryStore {
    readonly state: DeliveryState;
    readonly discardUnknown: () => string | null;
    readonly dismissFailure: () => void;
    readonly reconcile: (commandIds: readonly string[]) => void;
    readonly submit: (
        commandId: string,
        displayPrompt: string,
        request: Omit<SubmitRequest, "idempotencyKey">,
        signal: AbortSignal,
    ) => Promise<SubmissionOutcome>;
    readonly retry: (signal: AbortSignal) => Promise<SubmissionOutcome | null>;
}

function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        (cause instanceof MobiusApiError && cause.status >= 400 && cause.status < 500) ||
        (cause instanceof CloudApiError && cause.status !== null && cause.status >= 400 && cause.status < 500)
    );
}

export const createSessionDeliveryStore = (options: {
    readonly submit: (request: SubmitRequest, signal: AbortSignal) => Promise<AcceptedTurn>;
    /**
     * A submission whose outcome the previous pane could not confirm. It is
     * adopted as `delivery-unknown` so the user can retry or discard it, and
     * nothing is resubmitted without that decision.
     */
    readonly initialUnknown?: Journal | undefined;
}) => {
    const send = async (
        journal: Journal,
        signal: AbortSignal,
        set: (state: Pick<SessionDeliveryStore, "state">) => void,
    ): Promise<SubmissionOutcome> => {
        set({ state: { kind: "submitting", journal } });
        try {
            const accepted = await options.submit(
                {
                    additionalDirectoryIds: journal.request.additionalDirectoryIds,
                    content: journal.request.content,
                    images: journal.request.images,
                    resources: journal.request.resources,
                    idempotencyKey: journal.commandId,
                    ...(journal.request.disposition === undefined ? {} : { disposition: journal.request.disposition }),
                    ...(journal.request.targetCommandId === undefined
                        ? {}
                        : { targetCommandId: journal.request.targetCommandId }),
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
            set({ state: { kind: "delivery-unknown", journal } });
            return { kind: "delivery-unknown" };
        }
    };
    return createStore<SessionDeliveryStore>()((set, get) => ({
        state:
            options.initialUnknown === undefined
                ? { kind: "idle" }
                : { journal: options.initialUnknown, kind: "delivery-unknown" },
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
        reconcile: (commandIds) => {
            const state = get().state;
            // An in-flight request owns the disabled composer until it settles;
            // a live event must not expose the submitted draft to another send.
            if (state.kind === "delivery-unknown" && commandIds.includes(state.journal.commandId)) {
                set({ state: { kind: "idle" } });
            }
        },
        submit: async (commandId, displayPrompt, request, signal) =>
            await send({ commandId, displayPrompt, request }, signal, set),
        retry: async (signal) => {
            const state = get().state;
            return state.kind === "delivery-unknown" ? await send(state.journal, signal, set) : null;
        },
    }));
};
