import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";

export interface BotLifecycleStore {
    readonly announcement: string;
    readonly archiveConfirmationOpen: boolean;
    readonly changing: boolean;
    readonly error: string;
    readonly change: (action: "archive" | "resume" | "suspend", signal: AbortSignal) => Promise<void>;
    readonly setArchiveConfirmationOpen: (open: boolean) => void;
    readonly syncBot: (bot: MobiusBot) => void;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot operation failed.";
}

export const createBotLifecycleStore = (
    initialBot: MobiusBot,
    client: MobiusBotOwnerClient,
    refreshBot: () => Promise<MobiusBot>,
) =>
    createStore<BotLifecycleStore>()((set) => {
        let bot = initialBot;
        return {
            announcement: "",
            archiveConfirmationOpen: false,
            changing: false,
            error: "",
            change: async (action, signal) => {
                set({ announcement: "", changing: true, error: "" });
                try {
                    if (action === "suspend") {
                        await client.suspendBot(bot.botId, bot.lifecycleRevision, signal);
                        set({
                            announcement:
                                "Bot suspended. Existing history remains available, but new turns are blocked.",
                        });
                    } else if (action === "resume") {
                        await client.resumeBot(bot.botId, bot.lifecycleRevision, signal);
                        set({ announcement: "Bot resumed." });
                    } else {
                        await client.archiveBot(bot.botId, bot.lifecycleRevision, signal);
                        set({ announcement: "Bot archived.", archiveConfirmationOpen: false });
                    }
                    bot = await refreshBot();
                    signal.throwIfAborted();
                } catch (error) {
                    if (!signal.aborted) {
                        set({ announcement: "", error: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ changing: false });
                    }
                }
            },
            setArchiveConfirmationOpen: (archiveConfirmationOpen) => set({ archiveConfirmationOpen }),
            syncBot: (nextBot) => {
                bot = nextBot;
            },
        };
    });
