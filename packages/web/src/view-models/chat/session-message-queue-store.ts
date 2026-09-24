import type { MobiusTurn, PromptImage, SubmitMobiusTurnRequest } from "@moxt-ai/mobius-sdk";
import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

interface QueuedMessageValue {
    readonly commandId: string;
    readonly images: readonly PromptImage[];
    readonly summary: string;
    readonly turnId: string;
}

interface SessionMessageQueueJournalStore {
    readonly messagesBySession: ReadonlyMap<string, readonly QueuedMessageValue[]>;
    readonly write: (sessionId: string, messages: readonly QueuedMessageValue[]) => void;
}

const sessionMessageQueueJournal = createStore<SessionMessageQueueJournalStore>()((set) => ({
    messagesBySession: new Map(),
    write: (sessionId, messages) =>
        set((state) => {
            const messagesBySession = new Map(state.messagesBySession);
            if (messages.length === 0) {
                messagesBySession.delete(sessionId);
            } else {
                messagesBySession.set(sessionId, messages);
            }
            return { messagesBySession };
        }),
}));

export type ChatQueuedMessage =
    | ({ readonly kind: "queued" } & QueuedMessageValue)
    | ({ readonly kind: "steering" } & QueuedMessageValue)
    | ({ readonly kind: "deleting" } & QueuedMessageValue);

type QueueOperation = { readonly kind: "idle" } | { readonly kind: "submitting"; readonly commandId: string };
type QueueFeedback = { readonly kind: "none" } | { readonly kind: "failed"; readonly message: string };

interface SessionMessageQueuePort {
    readonly cancel: (turnId: string, idempotencyKey: string, signal: AbortSignal) => Promise<MobiusTurn>;
    readonly steer: (turnId: string, signal: AbortSignal) => Promise<void>;
    readonly submit: (request: SubmitMobiusTurnRequest, signal: AbortSignal) => Promise<{ readonly turnId: string }>;
}

export interface SessionMessageQueueStore {
    readonly feedback: QueueFeedback;
    readonly messages: readonly ChatQueuedMessage[];
    readonly operation: QueueOperation;
    readonly deleteMessage: (commandId: string, signal: AbortSignal) => Promise<ChatQueuedMessage | null>;
    readonly dismissFailure: () => void;
    readonly enqueue: (
        targetCommandId: string,
        summary: string,
        request: Omit<SubmitMobiusTurnRequest, "disposition" | "idempotencyKey" | "targetCommandId">,
        signal: AbortSignal,
    ) => Promise<ChatQueuedMessage | null>;
    readonly steerMessage: (commandId: string, signal: AbortSignal) => Promise<ChatQueuedMessage | null>;
    readonly reconcile: (commandIds: readonly string[]) => void;
    readonly takeStarted: (commandId: string) => ChatQueuedMessage | null;
}

function failureMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error ? cause.message : fallback;
}

function updateMessage(
    messages: readonly ChatQueuedMessage[],
    commandId: string,
    kind: ChatQueuedMessage["kind"],
): readonly ChatQueuedMessage[] {
    return messages.map((message) => (message.commandId === commandId ? { ...message, kind } : message));
}

export const createSessionMessageQueueStore = (options: {
    readonly port: SessionMessageQueuePort;
    readonly sessionId: string;
}) => {
    const restored = sessionMessageQueueJournal.getState().messagesBySession.get(options.sessionId) ?? [];
    const record = (messages: readonly ChatQueuedMessage[]): void => {
        sessionMessageQueueJournal.getState().write(
            options.sessionId,
            messages.map((message) => ({
                commandId: message.commandId,
                images: message.images,
                summary: message.summary,
                turnId: message.turnId,
            })),
        );
    };
    return createStore<SessionMessageQueueStore>()((set, get) => ({
        feedback: { kind: "none" },
        messages: restored.map((message) => ({ ...message, kind: "queued" })),
        operation: { kind: "idle" },
        deleteMessage: async (commandId, parent) => {
            const message = get().messages.find((candidate) => candidate.commandId === commandId);
            if (message === undefined || message.kind !== "queued") {
                return null;
            }
            set((state) => ({
                feedback: { kind: "none" },
                messages: updateMessage(state.messages, commandId, "deleting"),
            }));
            const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
            try {
                await options.port.cancel(message.turnId, crypto.randomUUID(), signal);
                signal.throwIfAborted();
                set((state) => {
                    const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
                    record(messages);
                    return { messages };
                });
                return message;
            } catch (cause) {
                if (parent.aborted) {
                    throw cause;
                }
                set((state) => ({
                    feedback: {
                        kind: "failed",
                        message: failureMessage(cause, "The queued message could not be deleted."),
                    },
                    messages: updateMessage(state.messages, commandId, "queued"),
                }));
                return null;
            }
        },
        dismissFailure: () => set({ feedback: { kind: "none" } }),
        enqueue: async (targetCommandId, summary, request, parent) => {
            if (get().operation.kind !== "idle") {
                return null;
            }
            const commandId = crypto.randomUUID();
            set({ feedback: { kind: "none" }, operation: { commandId, kind: "submitting" } });
            const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
            try {
                const accepted = await options.port.submit(
                    {
                        ...request,
                        disposition: SessionPromptDisposition.Queue,
                        idempotencyKey: commandId,
                        targetCommandId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const message: ChatQueuedMessage = {
                    commandId,
                    images: request.images,
                    kind: "queued",
                    summary,
                    turnId: accepted.turnId,
                };
                set((state) => {
                    const messages = [...state.messages, message];
                    record(messages);
                    return { messages, operation: { kind: "idle" } };
                });
                return message;
            } catch (cause) {
                if (parent.aborted) {
                    throw cause;
                }
                set({
                    feedback: { kind: "failed", message: failureMessage(cause, "The message could not be queued.") },
                    operation: { kind: "idle" },
                });
                return null;
            }
        },
        steerMessage: async (commandId, parent) => {
            const message = get().messages.find((candidate) => candidate.commandId === commandId);
            if (message === undefined || message.kind !== "queued") {
                return null;
            }
            set((state) => ({
                feedback: { kind: "none" },
                messages: updateMessage(state.messages, commandId, "steering"),
            }));
            const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
            try {
                await options.port.steer(message.turnId, signal);
                signal.throwIfAborted();
                set((state) => {
                    const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
                    record(messages);
                    return { messages };
                });
                return message;
            } catch (cause) {
                if (parent.aborted) {
                    throw cause;
                }
                set((state) => ({
                    feedback: {
                        kind: "failed",
                        message: failureMessage(cause, "The queued message could not steer the task."),
                    },
                    messages: updateMessage(state.messages, commandId, "queued"),
                }));
                return null;
            }
        },
        reconcile: (commandIds) => {
            const messages = get().messages.filter((message) => !commandIds.includes(message.commandId));
            record(messages);
            set({ messages });
        },
        takeStarted: (commandId) => {
            const message = get().messages.find((candidate) => candidate.commandId === commandId);
            if (message === undefined || message.kind !== "queued") {
                return null;
            }
            set((state) => {
                const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
                record(messages);
                return { messages };
            });
            return message;
        },
    }));
};
