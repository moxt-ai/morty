import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

export interface BotProfileStore {
    readonly announcement: string;
    readonly avatarRef: string;
    readonly description: string;
    readonly displayName: string;
    readonly error: string;
    readonly saving: boolean;
    readonly save: (signal: AbortSignal) => Promise<void>;
    readonly setAvatarRef: (value: string) => void;
    readonly setDescription: (value: string) => void;
    readonly setDisplayName: (value: string) => void;
    readonly syncBot: (bot: MobiusBot) => void;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot operation failed.";
}

export const createBotProfileStore = (
    initialBot: MobiusBot,
    client: MobiusBotOwnerClient,
    refreshBot: () => Promise<MobiusBot>,
) =>
    createStore<BotProfileStore>()((set, get) => {
        let bot = initialBot;
        return {
            announcement: "",
            avatarRef: initialBot.avatarRef,
            description: initialBot.description,
            displayName: initialBot.displayName,
            error: "",
            saving: false,
            save: async (signal) => {
                const state = get();
                const displayName = state.displayName.trim();
                if (displayName.length === 0) {
                    set({ announcement: "", error: "Enter a Bot name." });
                    return;
                }
                set({ error: "", saving: true });
                try {
                    await client.reviseProfile(
                        bot.botId,
                        {
                            avatarRef: state.avatarRef.trim(),
                            description: state.description.trim(),
                            displayName,
                            expectedRevision: bot.lifecycleRevision,
                        },
                        signal,
                    );
                    bot = await refreshBot();
                    signal.throwIfAborted();
                    set({ announcement: "Bot profile saved." });
                } catch (error) {
                    if (!signal.aborted) {
                        set({ announcement: "", error: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ saving: false });
                    }
                }
            },
            setAvatarRef: (avatarRef) => set({ avatarRef }),
            setDescription: (description) => set({ description }),
            setDisplayName: (displayName) => set({ displayName }),
            syncBot: (nextBot) => {
                if (nextBot === bot) {
                    return;
                }
                bot = nextBot;
                set({
                    avatarRef: nextBot.avatarRef,
                    description: nextBot.description,
                    displayName: nextBot.displayName,
                });
            },
        };
    });
