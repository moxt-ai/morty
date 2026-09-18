import { createStore } from "zustand/vanilla";
import { ChannelHistorySynchronizer } from "../../services/chat/channel-history-synchronizer.ts";
import { closeMobiusTransport, initializeMobiusTransport } from "../../services/chat/mobius-transport.ts";
import { readChannelHistoryForSynchronization } from "../../services/pairing/pairing-api.ts";
import { useChatStore } from "../chat-store.ts";
import type { ChannelConnection, ChannelHistory } from "./channel.ts";
import { PairingApiError } from "./channel.ts";

type ChannelWorkspaceState = { readonly kind: "loading" } | { readonly kind: "ready" };

export interface ChannelWorkspaceStore {
    readonly state: ChannelWorkspaceState;
    readonly start: (signal: AbortSignal) => void;
    readonly createConversation: () => void;
}

export const createChannelWorkspaceStore = (options: {
    readonly connection: ChannelConnection;
    readonly history: ChannelHistory;
    readonly initialSessionId: string;
    readonly navigateToSession: (sessionId: string) => void;
}) =>
    createStore<ChannelWorkspaceStore>()((set) => ({
        state: { kind: "loading" },
        start: (signal) => {
            useChatStore.getState().configureChannel(options.connection, options.history, options.initialSessionId);
            if (signal.aborted) {
                return;
            }
            const synchronizer = new ChannelHistorySynchronizer({
                applyHistory: (latestHistory) => {
                    useChatStore.getState().reconcileHistory(latestHistory);
                },
                hasActiveTurns: () =>
                    useChatStore.getState().conversations.some((conversation) => conversation.isRunning),
                readHistory: async (readSignal) =>
                    await readChannelHistoryForSynchronization(options.connection.channelId, readSignal),
                reportFailure: (error) => {
                    const message =
                        error instanceof PairingApiError
                            ? `${error.code}: ${error.message}`
                            : "The latest background task status could not be loaded.";
                    useChatStore.getState().reportHistorySyncFailure(message);
                },
            });
            const stop = () => {
                synchronizer.stop();
                void closeMobiusTransport();
            };
            signal.addEventListener("abort", stop, { once: true });
            synchronizer.start();
            initializeMobiusTransport(options.connection, synchronizer.notifyActivity);
            set({ state: { kind: "ready" } });
        },
        createConversation: () => {
            const chat = useChatStore.getState();
            chat.createConversation();
            const updated = useChatStore.getState();
            const active = updated.conversations.find(
                (conversation) => conversation.id === updated.activeConversationId,
            );
            if (active !== undefined) {
                options.navigateToSession(active.sessionId);
            }
        },
    }));
