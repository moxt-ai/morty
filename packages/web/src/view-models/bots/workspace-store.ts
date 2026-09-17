import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { createBotOwnerClient } from "@/services/bots/bot-api";
import type { ChannelConnection } from "@/view-models/chat/channel";
import { isIdentifier } from "@/view-models/chat/channel";

type BotWorkspaceState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bot: MobiusBot }
    | { readonly kind: "linked-device" }
    | { readonly kind: "failed"; readonly message: string };

export interface BotWorkspaceStore {
    readonly client: MobiusBotOwnerClient;
    readonly refreshing: boolean;
    readonly state: BotWorkspaceState;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly refresh: (signal: AbortSignal) => Promise<MobiusBot>;
}

function botLoadFailure(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot could not be loaded.";
}

export const createBotWorkspaceStore = (connection: ChannelConnection, botId: string) =>
    createStore<BotWorkspaceStore>()((set, get) => {
        const client = createBotOwnerClient(connection);
        const refresh = async (signal: AbortSignal): Promise<MobiusBot> => {
            set({ refreshing: true });
            try {
                const bot = await client.readBot(botId, signal);
                signal.throwIfAborted();
                set({ state: { bot, kind: "ready" } });
                return bot;
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        state:
                            error instanceof MobiusApiError && error.code === "owner_access_required"
                                ? { kind: "linked-device" }
                                : { kind: "failed", message: botLoadFailure(error) },
                    });
                }
                throw error;
            } finally {
                if (!signal.aborted) {
                    set({ refreshing: false });
                }
            }
        };
        return {
            client,
            refreshing: false,
            state: { kind: "loading" },
            load: async (signal) => {
                if (!isIdentifier(botId)) {
                    set({ state: { kind: "failed", message: "The Bot route is malformed." } });
                    return;
                }
                await get()
                    .refresh(signal)
                    .catch(() => undefined);
            },
            refresh,
        };
    });
