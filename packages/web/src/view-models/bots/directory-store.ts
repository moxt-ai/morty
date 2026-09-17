import { MobiusApiError, type MobiusBot } from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { createBotOwnerClient } from "@/services/bots/bot-api";
import type { ChannelConnection } from "@/view-models/chat/channel";

export type BotDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly bots: readonly MobiusBot[] }
    | { readonly kind: "linked-device" }
    | { readonly kind: "failed"; readonly message: string };

export type BotCreationState =
    | { readonly kind: "closed" }
    | {
          readonly kind: "editing";
          readonly avatarRef: string;
          readonly description: string;
          readonly displayName: string;
          readonly error: string;
          readonly submitting: boolean;
      };

export interface BotDirectoryStore {
    readonly creation: BotCreationState;
    readonly directory: BotDirectoryState;
    readonly closeCreation: () => void;
    readonly openCreation: () => void;
    readonly reload: (signal: AbortSignal) => Promise<void>;
    readonly setAvatarRef: (value: string) => void;
    readonly setDescription: (value: string) => void;
    readonly setDisplayName: (value: string) => void;
    readonly submitCreation: (signal: AbortSignal) => Promise<void>;
}

function botRequestError(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot request failed unexpectedly.";
}

const closedCreation: BotCreationState = { kind: "closed" };

export const createBotDirectoryStore = (connection: ChannelConnection, onCreated: (bot: MobiusBot) => Promise<void>) =>
    createStore<BotDirectoryStore>()((set, get) => {
        const client = createBotOwnerClient(connection);
        const updateCreation = (
            update: (current: Extract<BotCreationState, { readonly kind: "editing" }>) => BotCreationState,
        ): void => {
            const current = get().creation;
            if (current.kind === "editing") {
                set({ creation: update(current) });
            }
        };
        return {
            creation: closedCreation,
            directory: { kind: "loading" },
            closeCreation: () => set({ creation: closedCreation }),
            openCreation: () =>
                set({
                    creation: {
                        avatarRef: "",
                        description: "",
                        displayName: "",
                        error: "",
                        kind: "editing",
                        submitting: false,
                    },
                }),
            reload: async (signal) => {
                set({ directory: { kind: "loading" } });
                try {
                    const value = await client.listBots(signal);
                    signal.throwIfAborted();
                    set({ directory: { bots: value.bots, kind: "ready" } });
                } catch (error) {
                    if (signal.aborted) {
                        return;
                    }
                    set({
                        directory:
                            error instanceof MobiusApiError && error.code === "owner_access_required"
                                ? { kind: "linked-device" }
                                : { kind: "failed", message: botRequestError(error) },
                    });
                }
            },
            setAvatarRef: (avatarRef) => updateCreation((current) => ({ ...current, avatarRef })),
            setDescription: (description) => updateCreation((current) => ({ ...current, description })),
            setDisplayName: (displayName) => updateCreation((current) => ({ ...current, displayName })),
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
                    const bot = await client.createBot(
                        {
                            avatarRef: creation.avatarRef.trim(),
                            description: creation.description.trim(),
                            displayName,
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    await onCreated(bot);
                } catch (error) {
                    if (!signal.aborted) {
                        set({ creation: { ...creation, error: botRequestError(error), submitting: false } });
                    }
                }
            },
        };
    });

export function formatBotUpdatedAt(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
