import { MobiusApiError, MobiusCancellationError, type MobiusClient } from "@moxt-ai/mobius-sdk";
import * as v from "valibot";
import { createStore } from "zustand/vanilla";
import { CloudApiError } from "../../services/management/management-api.ts";

type SubmitRequest = Parameters<MobiusClient["turns"]["submit"]>[1];
type AcceptedTurn = { readonly turnId: string };
const stringListSchema = v.pipe(v.array(v.string()), v.readonly());
const submitRequestSchema = v.pipe(
    v.object({
        additionalDirectoryIds: stringListSchema,
        artifactIds: stringListSchema,
        content: v.string(),
        disposition: v.optional(v.string()),
        images: v.pipe(
            v.array(v.pipe(v.object({ data: v.string(), mimeType: v.string(), name: v.string() }), v.readonly())),
            v.readonly(),
        ),
        resources: v.pipe(
            v.array(
                v.pipe(
                    v.object({
                        mimeType: v.string(),
                        name: v.string(),
                        text: v.string(),
                        type: v.picklist(["embedded", "link"]),
                        uri: v.string(),
                    }),
                    v.readonly(),
                ),
            ),
            v.readonly(),
        ),
        targetCommandId: v.optional(v.string()),
    }),
    v.readonly(),
);
const journalSchema = v.pipe(
    v.object({ commandId: v.string(), displayPrompt: v.string(), request: submitRequestSchema }),
    v.readonly(),
);
type Journal = v.InferOutput<typeof journalSchema>;

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

function readJournal(storage: Storage, key: string): Journal | null {
    const value = storage.getItem(key);
    if (value === null) {
        return null;
    }
    try {
        const parsed = v.safeParse(journalSchema, JSON.parse(value));
        return parsed.success ? parsed.output : null;
    } catch {
        return null;
    }
}

function isAuthoritativeFailure(cause: unknown): boolean {
    return (
        (cause instanceof MobiusApiError && cause.status >= 400 && cause.status < 500) ||
        (cause instanceof CloudApiError && cause.status !== null && cause.status >= 400 && cause.status < 500)
    );
}

export const createSessionDeliveryStore = (options: {
    readonly sessionId: string;
    readonly storage: Storage;
    readonly submit: (request: SubmitRequest, signal: AbortSignal) => Promise<AcceptedTurn>;
}) => {
    const storageKey = `mobius.session-delivery.v1:${options.sessionId}`;
    const restored = readJournal(options.storage, storageKey);
    const send = async (
        journal: Journal,
        signal: AbortSignal,
        set: (state: Pick<SessionDeliveryStore, "state">) => void,
    ): Promise<AcceptedTurn | null> => {
        options.storage.setItem(storageKey, JSON.stringify(journal));
        set({ state: { kind: "submitting", journal } });
        try {
            const accepted = await options.submit(
                {
                    additionalDirectoryIds: journal.request.additionalDirectoryIds,
                    artifactIds: journal.request.artifactIds,
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
            options.storage.removeItem(storageKey);
            set({ state: { kind: "idle" } });
            return accepted;
        } catch (cause) {
            if (signal.aborted || cause instanceof MobiusCancellationError) {
                throw cause;
            }
            if (isAuthoritativeFailure(cause)) {
                options.storage.removeItem(storageKey);
                set({
                    state: {
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "The message was rejected.",
                    },
                });
                return null;
            }
            set({ state: { kind: "delivery-unknown", journal } });
            return null;
        }
    };
    return createStore<SessionDeliveryStore>()((set, get) => ({
        state: restored === null ? { kind: "idle" } : { kind: "delivery-unknown", journal: restored },
        discardUnknown: () => {
            const state = get().state;
            if (state.kind !== "delivery-unknown") {
                return null;
            }
            options.storage.removeItem(storageKey);
            set({ state: { kind: "idle" } });
            return state.journal.commandId;
        },
        reconcile: (commandIds) => {
            const state = get().state;
            if (
                (state.kind === "delivery-unknown" || state.kind === "submitting") &&
                commandIds.includes(state.journal.commandId)
            ) {
                options.storage.removeItem(storageKey);
                set({ state: { kind: "idle" } });
            }
        },
        submit: async (commandId, displayPrompt, request, signal) =>
            await send(v.parse(journalSchema, { commandId, displayPrompt, request }), signal, set),
        retry: async (signal) => {
            const state = get().state;
            return state.kind === "delivery-unknown" ? await send(state.journal, signal, set) : null;
        },
    }));
};
