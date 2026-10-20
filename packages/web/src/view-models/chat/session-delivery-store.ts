import { MobiusApiError, MobiusCancellationError, type MobiusClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { CloudApiError } from "../../services/management/management-api.ts";
import { formatError } from "../format-error.ts";

type SubmitRequest = Parameters<MobiusClient["turns"]["submit"]>[1];
export type AcceptedTurn = { readonly turnId: string };
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
    readonly reconcile: (commandIds: readonly string[]) => void;
    readonly submit: (
        commandId: string,
        displayPrompt: string,
        request: Omit<SubmitRequest, "idempotencyKey">,
        signal: AbortSignal,
    ) => Promise<AcceptedTurn | null>;
    readonly retry: (signal: AbortSignal) => Promise<AcceptedTurn | null>;
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
    ): Promise<AcceptedTurn | null> => {
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
            return accepted;
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
                return null;
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return null;
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
        reconcile: (commandIds) => {
            const state = get().state;
            if (
                (state.kind === "delivery-unknown" || state.kind === "submitting") &&
                commandIds.includes(state.journal.commandId)
            ) {
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
