import type { SubmitMobiusTurnRequest } from "@moxt-ai/mobius-sdk";
import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { formatError } from "../format-error.ts";
import type { QueuedCommand } from "./session-execution.ts";

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
type QueueFeedback =
    | { readonly kind: "none" }
    | {
          readonly kind: "failed";
          readonly operation: "submit" | "delete" | "steer";
          readonly commandId: string;
          readonly message: string;
      };

interface SessionMessageQueuePort {
    readonly cancel: (turnId: string, signal: AbortSignal) => Promise<void>;
    readonly steer: (turnId: string, signal: AbortSignal) => Promise<void>;
    readonly submit: (request: SubmitMobiusTurnRequest, signal: AbortSignal) => Promise<{ readonly turnId: string }>;
}

/**
 * This browser's request on a message the Runtime lists as queued. A withdrawn message, steered or deleted, stays
 * hidden until the Runtime's queue no longer lists it.
 */
type QueuedMessageRequest = "steering" | "deleting" | "withdrawn";

/**
 * This browser's part of the message queue. Which messages are queued is the Runtime's, kept by the Session pane's
 * execution; this store keeps only what this browser adds to them: its requests on them and the files it queued.
 */
export interface SessionMessageQueueStore {
    readonly feedback: QueueFeedback;
    readonly operation: QueueOperation;
    readonly requests: ReadonlyMap<string, QueuedMessageRequest>;
    /** The original files this browser queued, by command; the Runtime keeps only their uploaded references. */
    readonly attachments: ReadonlyMap<string, readonly ComposerAttachment[]>;
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
    /** The messages left the Runtime's queue: what this browser kept for them ends. */
    readonly left: (commandIds: readonly string[]) => void;
}

/** The queue as the user sees it: the Runtime's queued messages, with this browser's requests and files on them. */
export function queuedMessages(
    queued: readonly QueuedCommand[],
    queue: Pick<SessionMessageQueueStore, "attachments" | "requests">,
): readonly ChatQueuedMessage[] {
    return queued.flatMap((message): readonly ChatQueuedMessage[] => {
        const request = queue.requests.get(message.commandId);
        if (request === "withdrawn") {
            return [];
        }
        const attachments = queue.attachments.get(message.commandId);
        return [
            {
                commandId: message.commandId,
                turnId: message.commandId,
                summary: message.prompt || attachments?.map((attachment) => attachment.name).join(", ") || "",
                prompt: message.prompt,
                attachments:
                    attachments === undefined
                        ? { kind: "unrestorable", count: message.attachments.length }
                        : { kind: "restorable", values: attachments },
                kind: request ?? "queued",
            },
        ];
    });
}

function withRequest(
    requests: ReadonlyMap<string, QueuedMessageRequest>,
    commandId: string,
    request: QueuedMessageRequest | null,
): ReadonlyMap<string, QueuedMessageRequest> {
    const next = new Map(requests);
    if (request === null) {
        next.delete(commandId);
    } else {
        next.set(commandId, request);
    }
    return next;
}

function withoutAttachments(
    attachments: ReadonlyMap<string, readonly ComposerAttachment[]>,
    commandId: string,
): ReadonlyMap<string, readonly ComposerAttachment[]> {
    const next = new Map(attachments);
    next.delete(commandId);
    return next;
}

export const createSessionMessageQueueStore = (options: {
    readonly port: SessionMessageQueuePort;
    /** The messages the Runtime lists as queued, as the Session pane last observed them. */
    readonly queued: () => readonly QueuedCommand[];
}) => {
    const listed = (commandId: string): boolean => options.queued().some((message) => message.commandId === commandId);
    return createStore<SessionMessageQueueStore>()((set, get) => {
        /** Ends a request the Runtime accepted: the message stays hidden while the Runtime still lists it. */
        const withdrawn = (commandId: string): void => {
            set((state) => ({
                attachments: withoutAttachments(state.attachments, commandId),
                requests: withRequest(state.requests, commandId, listed(commandId) ? "withdrawn" : null),
            }));
        };
        const queuedMessage = (commandId: string): ChatQueuedMessage | null => {
            const message = queuedMessages(options.queued(), get()).find(
                (candidate) => candidate.commandId === commandId,
            );
            return message === undefined || message.kind !== "queued" ? null : message;
        };
        return {
            feedback: { kind: "none" },
            operation: { kind: "idle" },
            requests: new Map(),
            attachments: new Map(),
            deleteMessage: async (commandId, parent) => {
                const message = queuedMessage(commandId);
                if (message === null) {
                    return null;
                }
                set((state) => ({
                    feedback: { kind: "none" },
                    requests: withRequest(state.requests, commandId, "deleting"),
                }));
                const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
                try {
                    await options.port.cancel(message.turnId, signal);
                    signal.throwIfAborted();
                    withdrawn(commandId);
                    return message;
                } catch (cause) {
                    if (parent.aborted) {
                        throw cause;
                    }
                    set((state) => ({
                        feedback: {
                            kind: "failed",
                            operation: "delete",
                            commandId,
                            message: formatError(cause, "The queued message could not be deleted."),
                        },
                        requests: withRequest(state.requests, commandId, null),
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
                set((state) => ({
                    attachments: new Map(state.attachments).set(commandId, attachments),
                    feedback: { kind: "none" },
                    operation: { commandId, kind: "submitting" },
                }));
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
                    if (!listed(commandId)) {
                        set((state) => ({ attachments: withoutAttachments(state.attachments, commandId) }));
                    }
                    if (parent.aborted) {
                        throw cause;
                    }
                    set({
                        feedback: {
                            kind: "failed",
                            operation: "submit",
                            commandId,
                            message: formatError(cause, "The message could not be queued."),
                        },
                        operation: { kind: "idle" },
                    });
                    return null;
                }
            },
            steerMessage: async (commandId, parent) => {
                const message = queuedMessage(commandId);
                if (message === null) {
                    return null;
                }
                set((state) => ({
                    feedback: { kind: "none" },
                    requests: withRequest(state.requests, commandId, "steering"),
                }));
                const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
                try {
                    await options.port.steer(message.turnId, signal);
                    signal.throwIfAborted();
                    withdrawn(commandId);
                    return message;
                } catch (cause) {
                    if (parent.aborted) {
                        throw cause;
                    }
                    set((state) => ({
                        // Execution events and queue snapshots may arrive before the HTTP refusal.
                        ...(listed(commandId)
                            ? {
                                  feedback: {
                                      kind: "failed",
                                      operation: "steer",
                                      commandId,
                                      message: formatError(cause, "The queued message could not steer the task."),
                                  },
                              }
                            : {}),
                        requests: withRequest(state.requests, commandId, null),
                    }));
                    return null;
                }
            },
            left: (commandIds) => {
                const left = new Set(commandIds);
                set((state) => ({
                    attachments: new Map([...state.attachments].filter(([commandId]) => !left.has(commandId))),
                    requests: new Map([...state.requests].filter(([commandId]) => !left.has(commandId))),
                    // A refused steer has nothing left to report once its message leaves the queue.
                    feedback:
                        state.feedback.kind === "failed" &&
                        state.feedback.operation === "steer" &&
                        left.has(state.feedback.commandId)
                            ? { kind: "none" }
                            : state.feedback,
                }));
            },
        };
    });
};
