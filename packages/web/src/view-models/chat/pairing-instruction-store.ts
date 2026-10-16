import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "@/services/chat/bot-chat-api";
import { formatError } from "../format-error.ts";

type PairingInstructionState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly instruction: string; readonly expiresAt: string }
    | { readonly kind: "failed"; readonly message: string };

type CopyState = "idle" | "copied" | "failed";

export interface PairingInstructionStore {
    readonly copy: CopyState;
    readonly state: PairingInstructionState;
    readonly copyInstruction: () => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly resetCopy: () => void;
}

export const createPairingInstructionStore = (botId: string, requests: Pick<BotChatApi, "createPairingInstruction">) =>
    createStore<PairingInstructionStore>()((set, get) => ({
        copy: "idle",
        state: { kind: "loading" },
        copyInstruction: async () => {
            const state = get().state;
            if (state.kind !== "ready") {
                return;
            }
            if (navigator.clipboard === undefined) {
                set({ copy: "failed" });
                return;
            }
            try {
                await navigator.clipboard.writeText(state.instruction);
                set({ copy: "copied" });
            } catch {
                set({ copy: "failed" });
            }
        },
        load: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                const ticket = await requests.createPairingInstruction(botId, signal);
                signal.throwIfAborted();
                set({
                    state: {
                        kind: "ready",
                        expiresAt: ticket.expiresAt,
                        instruction: `Fetch ${ticket.url} and set up Morty for me. Don't ask me anything.`,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: formatError(cause, "Pairing is unavailable."),
                        },
                    });
                }
            }
        },
        resetCopy: () => set({ copy: "idle" }),
    }));
