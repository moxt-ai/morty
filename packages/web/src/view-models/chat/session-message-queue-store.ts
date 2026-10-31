import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { formatError } from "../format-error.ts";
import type { SubmittedMessage } from "./session-delivery-store.ts";
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

type QueueFeedback =
    | { readonly kind: "none" }
    | {
          readonly kind: "failed";
          readonly operation: "delete" | "steer";
          readonly commandId: string;
          readonly message: string;
      };

type QueueOperation = (turnId: string, signal: AbortSignal) => Promise<void>;

/** A withdrawn message stays hidden until an authoritative queue snapshot no longer lists it. */
type QueuedMessageRequest = "steering" | "deleting" | "withdrawn";

/** Session-owned requests on the Runtime's queue. Original files remain owned by delivery. */
export interface SessionMessageQueueStore {
    readonly feedback: QueueFeedback;
    readonly requests: ReadonlyMap<string, QueuedMessageRequest>;
    readonly deleteMessage: (
        message: ChatQueuedMessage | null,
        cancel: QueueOperation,
        signal: AbortSignal,
    ) => Promise<ChatQueuedMessage | null>;
    readonly dismissFailure: () => void;
    readonly steerMessage: (
        message: ChatQueuedMessage | null,
        steer: QueueOperation,
        signal: AbortSignal,
    ) => Promise<ChatQueuedMessage | null>;
    readonly reconcile: (queuedCommandIds: readonly string[]) => void;
    /** Ends operations borrowing a pane's connection, retaining completed withdrawals. */
    readonly interrupted: () => void;
}

/** The Runtime's queue, enriched from the Session's sole copy of local submitted messages. */
export function queuedMessages(
    queued: readonly QueuedCommand[],
    queue: Pick<SessionMessageQueueStore, "requests">,
    submitted: readonly SubmittedMessage[],
): readonly ChatQueuedMessage[] {
    return queued.flatMap((message): readonly ChatQueuedMessage[] => {
        const request = queue.requests.get(message.commandId);
        if (request === "withdrawn") {
            return [];
        }
        const local = submitted.find((candidate) => candidate.commandId === message.commandId)?.attachments;
        const attachments = local?.kind === "local" ? local.values : undefined;
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

/** Each operation borrows the selected pane's port; no connection outlives its pane. */
export const createSessionMessageQueueStore = () =>
    createStore<SessionMessageQueueStore>()((set, get) => {
        const withdrawn = (commandId: string): void => {
            set((state) => ({
                // A snapshot may already have removed the request while its HTTP response was in flight.
                requests: withRequest(state.requests, commandId, state.requests.has(commandId) ? "withdrawn" : null),
            }));
        };
        return {
            feedback: { kind: "none" },
            requests: new Map(),
            deleteMessage: async (message, cancel, parent) => {
                if (message === null || message.kind !== "queued" || get().requests.has(message.commandId)) {
                    return null;
                }
                const { commandId } = message;
                set((state) => ({
                    feedback: { kind: "none" },
                    requests: withRequest(state.requests, commandId, "deleting"),
                }));
                const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
                try {
                    await cancel(message.turnId, signal);
                    signal.throwIfAborted();
                    withdrawn(commandId);
                    return message;
                } catch (cause) {
                    parent.throwIfAborted();
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
            steerMessage: async (message, steer, parent) => {
                if (message === null || message.kind !== "queued" || get().requests.has(message.commandId)) {
                    return null;
                }
                const { commandId } = message;
                set((state) => ({
                    feedback: { kind: "none" },
                    requests: withRequest(state.requests, commandId, "steering"),
                }));
                const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
                try {
                    await steer(message.turnId, signal);
                    signal.throwIfAborted();
                    withdrawn(commandId);
                    return message;
                } catch (cause) {
                    parent.throwIfAborted();
                    set((state) => ({
                        // Execution events and queue snapshots may arrive before the HTTP refusal.
                        ...(state.requests.has(commandId)
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
            reconcile: (commandIds) => {
                const queued = new Set(commandIds);
                set((state) => ({
                    requests: new Map([...state.requests].filter(([commandId]) => queued.has(commandId))),
                    feedback:
                        state.feedback.kind === "failed" &&
                        state.feedback.operation === "steer" &&
                        !queued.has(state.feedback.commandId)
                            ? { kind: "none" }
                            : state.feedback,
                }));
            },
            interrupted: () => {
                set((state) => ({
                    requests: new Map([...state.requests].filter(([, request]) => request === "withdrawn")),
                }));
            },
        };
    });
