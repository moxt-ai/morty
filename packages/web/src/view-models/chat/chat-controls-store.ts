import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";
import type { MobiusBrowserClient } from "@moxt-ai/mobius-sdk/browser";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatWorkspace } from "@/services/chat/bot-chat-api";

type ChatControlsInventory =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly options: readonly SessionConfigOption[];
          readonly harness: string;
      }
    | { readonly kind: "failed"; readonly message: string };
type ChatControlsChange =
    | { readonly kind: "idle" }
    | { readonly kind: "configuration"; readonly configId: string; readonly value: string }
    | { readonly kind: "failed"; readonly message: string };

export interface ChatControlsStore {
    readonly change: ChatControlsChange;
    readonly inventory: ChatControlsInventory;
    readonly open: (signal: AbortSignal) => Promise<void>;
    readonly select: (value: string, configId: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, milliseconds);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createChatControlsStore = (
    botId: string,
    client: MobiusBrowserClient,
    requests: Pick<BotChatApi, "workspace">,
) =>
    createStore<ChatControlsStore>()((set, get) => {
        let activeSelection: AbortController | null = null;
        return {
            change: { kind: "idle" },
            inventory: { kind: "loading" },
            open: async (signal) => {
                set({ inventory: { kind: "loading" } });
                try {
                    const [workspace, snapshot, configuration] = await Promise.all([
                        requests.workspace(botId, signal),
                        client.session.read(signal),
                        client.configuration.read(signal),
                    ]);
                    signal.throwIfAborted();
                    set({
                        inventory: {
                            harness: `${snapshot.session.defaultBinding.runtimeId}:${snapshot.session.defaultBinding.agentRef}`,
                            kind: "ready",
                            options: configuration.options,
                            workspace,
                        },
                    });
                    while (!signal.aborted) {
                        await wait(5_000, signal);
                        signal.throwIfAborted();
                        const refreshed = await requests.workspace(botId, signal);
                        signal.throwIfAborted();
                        const current = get().inventory;
                        if (current.kind === "ready") {
                            set({ inventory: { ...current, workspace: refreshed } });
                        }
                    }
                } catch (cause) {
                    if (!signal.aborted) {
                        set({
                            inventory: {
                                kind: "failed",
                                message: cause instanceof Error ? cause.message : "Agent settings are unavailable.",
                            },
                        });
                    }
                } finally {
                    activeSelection?.abort();
                }
            },
            select: async (value, configId, disabled, lifetimeSignal) => {
                if (get().inventory.kind !== "ready" || disabled) {
                    return;
                }
                activeSelection?.abort();
                const operation = new AbortController();
                activeSelection = operation;
                const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(45_000)]);
                set({ change: { configId, kind: "configuration", value } });
                try {
                    await client.configuration.update(
                        {
                            additionalDirectoryIds: [],
                            booleanValue: false,
                            configId,
                            idempotencyKey: crypto.randomUUID(),
                            value,
                            valueType: "select",
                        },
                        signal,
                    );
                    const updated = await client.configuration.read(signal);
                    signal.throwIfAborted();
                    const inventory = get().inventory;
                    if (inventory.kind === "ready") {
                        set({ inventory: { ...inventory, options: updated.options } });
                    }
                    const applied = updated.options.some(
                        (option) => option.id === configId && option.currentValue === value,
                    );
                    set({
                        change: applied
                            ? { kind: "idle" }
                            : {
                                  kind: "failed",
                                  message:
                                      "The agent has not confirmed this selection. Check that your local Runtime is running.",
                              },
                    });
                } catch (cause) {
                    if (!lifetimeSignal.aborted && !operation.signal.aborted) {
                        set({
                            change: {
                                kind: "failed",
                                message: cause instanceof Error ? cause.message : "The selection could not be applied.",
                            },
                        });
                    }
                } finally {
                    if (activeSelection === operation) {
                        activeSelection = null;
                    }
                }
            },
        };
    });
