import { createStore } from "zustand/vanilla";
import type { ChatBot, ChatBotApi } from "@/services/bots/bot-api";

type BotDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bots: readonly ChatBot[] }
    | { readonly kind: "failed"; readonly message: string };

type BotCreationState =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly displayName: string; readonly error: string; readonly submitting: boolean };

export interface BotDirectoryStore {
    readonly creation: BotCreationState;
    readonly directory: BotDirectoryState;
    readonly closeCreation: () => void;
    readonly openCreation: () => void;
    readonly reload: (signal: AbortSignal) => Promise<void>;
    readonly setDisplayName: (value: string) => void;
    readonly submitCreation: (signal: AbortSignal) => Promise<void>;
}

export const createBotDirectoryStore = (api: ChatBotApi, onCreated: (bot: ChatBot) => Promise<void>) =>
    createStore<BotDirectoryStore>()((set, get) => ({
        creation: { kind: "closed" },
        directory: { kind: "loading" },
        closeCreation: () => set({ creation: { kind: "closed" } }),
        openCreation: () => set({ creation: { kind: "editing", displayName: "", error: "", submitting: false } }),
        reload: async (signal) => {
            set({ directory: { kind: "loading" } });
            try {
                const bots = await api.listBots(signal);
                signal.throwIfAborted();
                set({ directory: { kind: "ready", bots } });
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        directory: {
                            kind: "failed",
                            message:
                                error instanceof Error ? error.message : "The Chat Bot directory could not be loaded.",
                        },
                    });
                }
            }
        },
        setDisplayName: (displayName) => {
            const creation = get().creation;
            if (creation.kind === "editing") {
                set({ creation: { ...creation, displayName } });
            }
        },
        submitCreation: async (signal) => {
            const creation = get().creation;
            if (creation.kind !== "editing" || creation.submitting) {
                return;
            }
            const displayName = creation.displayName.trim();
            if (displayName.length === 0) {
                set({ creation: { ...creation, error: "Enter a name for this Bot." } });
                return;
            }
            set({ creation: { ...creation, error: "", submitting: true } });
            try {
                const bot = await api.createBot(displayName, signal);
                signal.throwIfAborted();
                await onCreated(bot);
            } catch (error) {
                if (!signal.aborted) {
                    set({
                        creation: {
                            ...creation,
                            error: error instanceof Error ? error.message : "The Chat Bot could not be created.",
                            submitting: false,
                        },
                    });
                }
            }
        },
    }));
