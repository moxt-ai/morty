import { MobiusApiError, type MobiusBotConversation, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly conversations: readonly MobiusBotConversation[] }
    | { readonly kind: "failed"; readonly message: string };

export interface BotConversationDirectoryStore {
    readonly creating: boolean;
    readonly error: string;
    readonly state: ConversationDirectoryState;
    readonly createConversation: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

function failureMessage(error: unknown): string {
    if (error instanceof MobiusApiError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : "The conversation request failed.";
}

export const createBotConversationDirectoryStore = (
    botId: string,
    client: MobiusBotOwnerClient,
    onCreated: (conversationId: string) => Promise<void>,
) =>
    createStore<BotConversationDirectoryStore>()((set) => ({
        creating: false,
        error: "",
        state: { kind: "loading" },
        createConversation: async (signal) => {
            set({ creating: true, error: "" });
            try {
                const conversation = await client.createConversation(
                    botId,
                    { clientConversationKey: `web_${crypto.randomUUID()}` },
                    signal,
                );
                signal.throwIfAborted();
                await onCreated(conversation.conversationId);
            } catch (error) {
                if (!signal.aborted) {
                    set({ error: failureMessage(error) });
                }
            } finally {
                if (!signal.aborted) {
                    set({ creating: false });
                }
            }
        },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const directory = await client.listConversations(botId, signal);
                signal.throwIfAborted();
                set({ state: { conversations: directory.conversations, kind: "ready" } });
            } catch (error) {
                if (!signal.aborted) {
                    set({ state: { kind: "failed", message: failureMessage(error) } });
                }
            }
        },
    }));

export function botConversationTitle(conversation: MobiusBotConversation): string {
    return conversation.title.trim().length > 0 ? conversation.title : "Untitled conversation";
}

export function formatBotConversationDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
