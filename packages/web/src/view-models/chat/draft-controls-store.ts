import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "@/services/chat/bot-chat-api";

type DraftSettingsState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "ready";
          readonly workspace: ChatWorkspace;
          readonly bindingId: string;
          readonly options: readonly SessionConfigOption[];
      };

export interface DraftControlsStore {
    readonly settings: DraftSettingsState;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly selectHarness: (value: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
    readonly selectModel: (configId: string, value: string) => void;
}

function wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, 1_000);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createDraftControlsStore = (
    botId: string,
    requests: Pick<BotChatApi, "workspace" | "selectAgent" | "draftSettings">,
    onSettings: (settings: ChatDraftConfiguration | null) => void,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        let selectedHarness = "";
        const load = async (lifetimeSignal: AbortSignal): Promise<void> => {
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            set({ settings: { kind: "loading" } });
            onSettings(null);
            try {
                while (!signal.aborted) {
                    const workspace = await requests.workspace(botId, signal);
                    const selected = workspace.selected;
                    if (
                        selected !== null &&
                        (selectedHarness === "" || `${selected.runtimeId}:${selected.agentRef}` === selectedHarness)
                    ) {
                        const result = await requests.draftSettings(botId, signal);
                        signal.throwIfAborted();
                        set({ settings: { kind: "ready", workspace, ...result } });
                        const model = result.options.find(
                            (option) => option.category === "model" && option.type !== "boolean",
                        );
                        onSettings(
                            model === undefined
                                ? null
                                : {
                                      bindingId: result.bindingId,
                                      configuration: {
                                          additionalDirectoryIds: [],
                                          booleanValue: false,
                                          configId: model.id,
                                          value: model.currentValue,
                                          valueType: "select",
                                      },
                                  },
                        );
                        return;
                    }
                    await wait(signal);
                }
            } catch (cause) {
                if (!lifetimeSignal.aborted) {
                    set({
                        settings: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "Harness settings are unavailable.",
                        },
                    });
                }
            }
        };
        return {
            settings: { kind: "loading" },
            load,
            selectHarness: async (value, disabled, signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready" || disabled) {
                    return;
                }
                const agent = settings.workspace.agents.find(
                    (item) => `${item.runtimeId}:${item.agentRef}` === value && item.online,
                );
                if (agent === undefined) {
                    return;
                }
                set({ settings: { kind: "loading" } });
                onSettings(null);
                try {
                    await requests.selectAgent(
                        botId,
                        {
                            agentConfigRevision: 1,
                            agentRef: agent.agentRef,
                            runtimeId: agent.runtimeId,
                            workspaceRef: "default",
                        },
                        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                    );
                    signal.throwIfAborted();
                    selectedHarness = value;
                    await load(signal);
                } catch (cause) {
                    if (!signal.aborted) {
                        set({
                            settings: {
                                kind: "failed",
                                message: cause instanceof Error ? cause.message : "The harness could not be selected.",
                            },
                        });
                    }
                }
            },
            selectModel: (configId, value) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                set({
                    settings: {
                        ...settings,
                        options: settings.options.map((option) =>
                            option.id === configId ? { ...option, currentValue: value } : option,
                        ),
                    },
                });
                onSettings({
                    bindingId: settings.bindingId,
                    configuration: {
                        additionalDirectoryIds: [],
                        booleanValue: false,
                        configId,
                        value,
                        valueType: "select",
                    },
                });
            },
        };
    });
