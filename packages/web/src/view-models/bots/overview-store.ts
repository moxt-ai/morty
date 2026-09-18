import { createStore } from "zustand/vanilla";
import type { ChatBotApi, ChatBotDetail } from "@/services/bots/bot-api";
import type { ChatWorkspace } from "@/services/chat/bot-chat-api";

type SaveState =
    | { readonly kind: "idle" }
    | { readonly kind: "saving" }
    | { readonly kind: "failed"; readonly message: string };
export type BotOverviewState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly displayName: string;
          readonly instructions: string;
          readonly save: SaveState;
          readonly workspace: ChatWorkspace;
      }
    | { readonly kind: "failed"; readonly message: string };

export interface BotOverviewStore {
    readonly state: BotOverviewState;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly save: (signal: AbortSignal) => Promise<void>;
    readonly setDisplayName: (value: string) => void;
    readonly setInstructions: (value: string) => void;
}

export const createBotOverviewStore = (api: ChatBotApi, bot: ChatBotDetail) =>
    createStore<BotOverviewStore>()((set, get) => {
        const updateReady = (
            update: (state: Extract<BotOverviewState, { readonly kind: "ready" }>) => BotOverviewState,
        ) => {
            const state = get().state;
            if (state.kind === "ready") {
                set({ state: update(state) });
            }
        };
        return {
            state: { kind: "loading" },
            load: async (signal) => {
                set({ state: { kind: "loading" } });
                try {
                    const workspace = await api.workspace(bot.botId, signal);
                    signal.throwIfAborted();
                    set({
                        state: {
                            kind: "ready",
                            displayName: bot.displayName,
                            instructions: bot.instructions,
                            save: { kind: "idle" },
                            workspace,
                        },
                    });
                } catch (error) {
                    if (!signal.aborted) {
                        set({
                            state: {
                                kind: "failed",
                                message: error instanceof Error ? error.message : "Bot configuration is unavailable.",
                            },
                        });
                    }
                }
            },
            save: async (signal) => {
                const state = get().state;
                if (state.kind !== "ready" || state.save.kind === "saving") {
                    return;
                }
                const displayName = state.displayName.trim();
                if (displayName.length === 0) {
                    set({ state: { ...state, save: { kind: "failed", message: "Enter a Bot name." } } });
                    return;
                }
                set({ state: { ...state, save: { kind: "saving" } } });
                try {
                    const saved = await api.updateBot(
                        bot.botId,
                        { displayName, instructions: state.instructions },
                        signal,
                    );
                    signal.throwIfAborted();
                    updateReady((current) => ({
                        ...current,
                        displayName: saved.displayName,
                        instructions: saved.instructions,
                        save: { kind: "idle" },
                    }));
                } catch (error) {
                    if (!signal.aborted) {
                        updateReady((current) => ({
                            ...current,
                            save: {
                                kind: "failed",
                                message: error instanceof Error ? error.message : "The Bot could not be saved.",
                            },
                        }));
                    }
                }
            },
            setDisplayName: (displayName) =>
                updateReady((state) => ({ ...state, displayName, save: { kind: "idle" } })),
            setInstructions: (instructions) =>
                updateReady((state) => ({ ...state, instructions, save: { kind: "idle" } })),
        };
    });
