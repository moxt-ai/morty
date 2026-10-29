import type { SubmitMobiusTurnRequest } from "@moxt-ai/mobius-sdk";
import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import type { NativeSessionResult } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { formatError } from "../format-error.ts";

type QueuedMessageAttachments =
    | { readonly kind: "restorable"; readonly values: readonly ComposerAttachment[] }
    | { readonly kind: "unrestorable"; readonly count: number };

interface QueuedMessageValue {
    readonly commandId: string;
    readonly attachments: QueuedMessageAttachments;
    readonly prompt: string;
    readonly summary: string;
    readonly turnId: string;
}

export type ChatQueuedMessage =
    | ({ readonly kind: "queued" } & QueuedMessageValue)
    | ({ readonly kind: "steering" } & QueuedMessageValue)
    | ({ readonly kind: "deleting" } & QueuedMessageValue);

type QueueOperation = { readonly kind: "idle" } | { readonly kind: "submitting"; readonly commandId: string };
type QueueFeedback = { readonly kind: "none" } | { readonly kind: "failed"; readonly message: string };

interface SessionMessageQueuePort {
    readonly cancel: (turnId: string, idempotencyKey: string, signal: AbortSignal) => Promise<void>;
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
        attachments: readonly ComposerAttachment[],
        signal: AbortSignal,
    ) => Promise<ChatQueuedMessage | null>;
    readonly steerMessage: (commandId: string, signal: AbortSignal) => Promise<ChatQueuedMessage | null>;
    readonly replace: (messages: Extract<NativeSessionResult, { readonly action: "active-turn" }>["queued"]) => void;
    readonly takeStarted: (commandId: string) => ChatQueuedMessage | null;
}

function updateMessage(
    messages: readonly ChatQueuedMessage[],
    commandId: string,
    kind: ChatQueuedMessage["kind"],
): readonly ChatQueuedMessage[] {
    return messages.map((message) => (message.commandId === commandId ? { ...message, kind } : message));
}

export const createSessionMessageQueueStore = (options: { readonly port: SessionMessageQueuePort }) => {
    // Runtime snapshots own queue membership; this browser owns the original attachment bytes.
    const localAttachments = new Map<string, readonly ComposerAttachment[]>();
    return createStore<SessionMessageQueueStore>()((set, get) => ({
        feedback: { kind: "none" },
        messages: [],
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
                localAttachments.delete(commandId);
                set((state) => {
                    const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
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
                        message: formatError(cause, "The queued message could not be deleted."),
                    },
                    messages: updateMessage(state.messages, commandId, "queued"),
                }));
                return null;
            }
        },
        dismissFailure: () => set({ feedback: { kind: "none" } }),
        enqueue: async (targetCommandId, summary, request, attachments, parent) => {
            if (get().operation.kind !== "idle") {
                return null;
            }
            const commandId = crypto.randomUUID();
            localAttachments.set(commandId, attachments);
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
                    attachments: { kind: "restorable", values: attachments },
                    kind: "queued",
                    prompt: request.content,
                    summary,
                    turnId: accepted.turnId,
                };
                set({ operation: { kind: "idle" } });
                return message;
            } catch (cause) {
                if (!get().messages.some((message) => message.commandId === commandId)) {
                    localAttachments.delete(commandId);
                }
                if (parent.aborted) {
                    throw cause;
                }
                set({
                    feedback: { kind: "failed", message: formatError(cause, "The message could not be queued.") },
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
                localAttachments.delete(commandId);
                set((state) => {
                    const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
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
                        message: formatError(cause, "The queued message could not steer the task."),
                    },
                    messages: updateMessage(state.messages, commandId, "queued"),
                }));
                return null;
            }
        },
        replace: (messages) => {
            const operation = get().operation;
            const queuedIds = new Set(messages.map((message) => message.commandId));
            for (const commandId of localAttachments.keys()) {
                if (
                    !queuedIds.has(commandId) &&
                    !(operation.kind === "submitting" && operation.commandId === commandId)
                ) {
                    localAttachments.delete(commandId);
                }
            }
            set((state) => ({
                messages: messages.map((message) => {
                    const attachments = localAttachments.get(message.commandId);
                    return {
                        commandId: message.commandId,
                        turnId: message.commandId,
                        summary: message.prompt || attachments?.map((attachment) => attachment.name).join(", ") || "",
                        prompt: message.prompt,
                        attachments:
                            attachments === undefined
                                ? { kind: "unrestorable", count: message.attachments.length }
                                : { kind: "restorable", values: attachments },
                        kind:
                            state.messages.find((current) => current.commandId === message.commandId)?.kind ?? "queued",
                    };
                }),
            }));
        },
        takeStarted: (commandId) => {
            localAttachments.delete(commandId);
            const message = get().messages.find((candidate) => candidate.commandId === commandId);
            if (message === undefined) {
                return null;
            }
            set((state) => {
                const messages = state.messages.filter((candidate) => candidate.commandId !== commandId);
                return { messages };
            });
            return message;
        },
    }));
};
