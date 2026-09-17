import {
    MobiusApiError,
    MobiusBotConversation,
    type MobiusBotConversationEvent,
    type MobiusBotOwnerClient,
    type MobiusMessage,
    type PromptImage,
    type PromptResource,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { readBotConversationMessages } from "@/services/bots/bot-api";
import type { ChannelConnection } from "@/view-models/chat/channel";

const WORKING_ANNOUNCEMENT = "Message accepted. The approved local runtime is working.";

type ConversationTurn =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly turnId: string }
    | { readonly kind: "running-without-identifier" };

type ConversationViewState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly conversation: MobiusBotConversation;
          readonly messages: readonly MobiusMessage[];
          readonly nextCursor: string;
          readonly turn: ConversationTurn;
      }
    | { readonly kind: "failed"; readonly message: string };

type OptimisticBotPrompt =
    | { readonly kind: "empty" }
    | {
          readonly kind: "pending";
          readonly clientMessageId: string;
          readonly images: readonly PromptImage[];
          readonly resources: readonly PromptResource[];
          readonly text: string;
      };

export interface ConversationThreadStore {
    readonly announcement: string;
    readonly cancelling: boolean;
    readonly loadingEarlier: boolean;
    readonly operationError: string;
    readonly optimisticPrompt: OptimisticBotPrompt;
    readonly state: ConversationViewState;
    readonly cancel: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly loadEarlier: (signal: AbortSignal) => Promise<void>;
    readonly markSubmitted: (
        clientMessageId: string,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        turnId: string,
        title: string | null,
        signal: AbortSignal,
    ) => void;
    readonly open: (signal: AbortSignal) => Promise<void>;
    readonly reportError: (message: string) => void;
    readonly resetOptimistic: () => void;
}

function failureMessage(error: unknown): string {
    if (error instanceof MobiusApiError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : "The conversation request failed.";
}

function turnState(
    messages: readonly MobiusMessage[],
    events: readonly MobiusBotConversationEvent[],
): ConversationTurn {
    const latestMessage = messages.at(-1);
    if (
        latestMessage === undefined ||
        latestMessage.attempt.kind === "succeeded" ||
        latestMessage.attempt.kind === "failed" ||
        latestMessage.attempt.kind === "cancelled"
    ) {
        return { kind: "idle" };
    }
    const latestEvent = events.findLast((event) => event.payload["commandId"] === latestMessage.commandId);
    if (latestEvent === undefined) {
        return { kind: "running-without-identifier" };
    }
    if (
        latestEvent.kind === "session.completed" ||
        latestEvent.kind === "session.failed" ||
        latestEvent.kind === "session.cancelled"
    ) {
        return { kind: "idle" };
    }
    return { kind: "running", turnId: latestEvent.turnId };
}

function mergeMessages(
    current: readonly MobiusMessage[],
    received: readonly MobiusMessage[],
): readonly MobiusMessage[] {
    const messages = new Map(current.map((message) => [message.commandId, message]));
    for (const message of received) {
        messages.set(message.commandId, message);
    }
    return Object.freeze(
        [...messages.values()].sort((left, right) => {
            const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
            return difference === 0 ? left.commandId.localeCompare(right.commandId) : difference;
        }),
    );
}

function retitle(conversation: MobiusBotConversation, title: string): MobiusBotConversation {
    return new MobiusBotConversation(
        {
            behaviorRevisionId: conversation.behaviorRevisionId,
            bindingId: conversation.bindingId,
            bindingRevision: conversation.bindingRevision,
            botId: conversation.botId,
            clientConversationKey: conversation.clientConversationKey,
            conversationId: conversation.conversationId,
            createdAt: conversation.createdAt,
            creatorPrincipalId: conversation.creatorPrincipalId,
            sessionId: conversation.sessionId,
            title,
        },
        conversation.origin,
        conversation.state,
    );
}

function wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, 1_500);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createConversationThreadStore = (
    botId: string,
    conversationId: string,
    client: MobiusBotOwnerClient,
    connection: ChannelConnection,
) =>
    createStore<ConversationThreadStore>()((set, get) => {
        const load = async (signal: AbortSignal): Promise<void> => {
            try {
                const directory = await client.listConversations(botId, signal);
                const conversation = directory.conversations.find(
                    (candidate) => candidate.conversationId === conversationId,
                );
                if (conversation === undefined) {
                    set({ state: { kind: "failed", message: "The Bot conversation does not exist." } });
                    return;
                }
                const [messages, events] = await Promise.all([
                    readBotConversationMessages(connection, conversation.sessionId, "", signal),
                    client.readConversationEvents(botId, conversation.conversationId, "", signal),
                ]);
                signal.throwIfAborted();
                const chronological = messages.messages.toReversed();
                const previous = get().state;
                const wasRunning = previous.kind === "ready" && previous.turn.kind !== "idle";
                const turn = turnState(chronological, events.events);
                const optimisticPrompt = get().optimisticPrompt;
                set({
                    announcement:
                        wasRunning && turn.kind === "idle" && get().announcement === WORKING_ANNOUNCEMENT
                            ? "Response completed."
                            : get().announcement,
                    optimisticPrompt:
                        optimisticPrompt.kind === "pending" &&
                        messages.messages.some((message) => message.commandId === optimisticPrompt.clientMessageId)
                            ? { kind: "empty" }
                            : optimisticPrompt,
                    state: {
                        conversation,
                        kind: "ready",
                        messages: mergeMessages(
                            previous.kind === "ready" &&
                                previous.conversation.conversationId === conversation.conversationId
                                ? previous.messages
                                : [],
                            chronological,
                        ),
                        nextCursor: previous.kind === "ready" ? previous.nextCursor : messages.nextCursor,
                        turn,
                    },
                });
            } catch (error) {
                if (!signal.aborted) {
                    set({ state: { kind: "failed", message: failureMessage(error) } });
                }
            }
        };

        const watch = async (signal: AbortSignal): Promise<void> => {
            while (!signal.aborted) {
                const state = get().state;
                if (state.kind !== "ready" || state.turn.kind === "idle") {
                    return;
                }
                await wait(signal);
                if (!signal.aborted) {
                    await load(signal);
                }
            }
        };

        return {
            announcement: "",
            cancelling: false,
            loadingEarlier: false,
            operationError: "",
            optimisticPrompt: { kind: "empty" },
            state: { kind: "loading" },
            cancel: async (signal) => {
                const state = get().state;
                if (state.kind !== "ready" || state.turn.kind !== "running") {
                    return;
                }
                set({ cancelling: true, operationError: "" });
                try {
                    await client.cancelTurn(botId, state.turn.turnId, `web_${crypto.randomUUID()}`, signal);
                    signal.throwIfAborted();
                    set({ announcement: "Cancellation accepted." });
                    await load(signal);
                } catch (error) {
                    if (!signal.aborted) {
                        set({ operationError: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ cancelling: false });
                    }
                }
            },
            load,
            loadEarlier: async (signal) => {
                const current = get().state;
                if (current.kind !== "ready" || current.nextCursor.length === 0) {
                    return;
                }
                set({ loadingEarlier: true, operationError: "" });
                try {
                    const page = await readBotConversationMessages(
                        connection,
                        current.conversation.sessionId,
                        current.nextCursor,
                        signal,
                    );
                    signal.throwIfAborted();
                    const latest = get().state;
                    if (
                        latest.kind === "ready" &&
                        latest.conversation.conversationId === current.conversation.conversationId
                    ) {
                        set({
                            state: {
                                ...latest,
                                messages: mergeMessages(latest.messages, page.messages.toReversed()),
                                nextCursor: page.nextCursor,
                            },
                        });
                    }
                } catch (error) {
                    if (!signal.aborted) {
                        set({ operationError: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ loadingEarlier: false });
                    }
                }
            },
            markSubmitted: (clientMessageId, text, images, resources, turnId, title, signal) => {
                const state = get().state;
                if (state.kind !== "ready") {
                    return;
                }
                set({
                    announcement: WORKING_ANNOUNCEMENT,
                    operationError: "",
                    optimisticPrompt: { clientMessageId, images, kind: "pending", resources, text },
                    state: {
                        ...state,
                        conversation: title === null ? state.conversation : retitle(state.conversation, title),
                        turn: { kind: "running", turnId },
                    },
                });
                void watch(signal);
            },
            open: async (signal) => {
                await load(signal);
                await watch(signal);
            },
            reportError: (operationError) => set({ operationError }),
            resetOptimistic: () => set({ optimisticPrompt: { kind: "empty" } }),
        };
    });
