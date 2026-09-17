import {
    MobiusApiError,
    type MobiusBot,
    type MobiusBotOwnerClient,
    MobiusNoBotCompletionPolicy,
    MobiusRequiredBotCompletionPolicy,
    MobiusUnavailableBotBindingState,
} from "@moxt-ai/mobius-sdk";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { BotConfigurationStore } from "@/view-models/bots/overview-configuration-store";
import type { ChannelConnection } from "@/view-models/chat/channel";

const REFRESH_MILLISECONDS = 250;

export interface BotActivationStore {
    readonly announcement: string;
    readonly error: string;
    readonly requesting: boolean;
    readonly activate: (signal: AbortSignal) => Promise<void>;
    readonly open: (signal: AbortSignal) => Promise<void>;
    readonly syncBot: (bot: MobiusBot) => void;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot operation failed.";
}

function wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(finish, REFRESH_MILLISECONDS);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}

export const createBotActivationStore = (
    initialBot: MobiusBot,
    client: MobiusBotOwnerClient,
    connection: ChannelConnection,
    configurationStore: StoreApi<BotConfigurationStore>,
    refreshBot: () => Promise<MobiusBot>,
) =>
    createStore<BotActivationStore>()((set) => {
        let bot = initialBot;

        const watch = async (bindingId: string, signal: AbortSignal): Promise<void> => {
            while (!signal.aborted) {
                await wait(signal);
                if (signal.aborted) {
                    return;
                }
                await Promise.all([configurationStore.getState().load(signal), refreshBot().catch(() => undefined)]);
                const configuration = configurationStore.getState().configuration;
                if (configuration.kind !== "ready") {
                    continue;
                }
                const binding = configuration.bindings.find((candidate) => candidate.bindingId === bindingId);
                if (binding?.state.kind === "approved") {
                    set({ announcement: `Bot activated on ${connection.machineName}.` });
                    const refreshed = await refreshBot().catch(() => undefined);
                    if (refreshed !== undefined) {
                        bot = refreshed;
                    }
                    return;
                }
                if (binding?.state instanceof MobiusUnavailableBotBindingState) {
                    set({ announcement: "", error: `${binding.state.code}: ${binding.state.message}` });
                    return;
                }
            }
        };

        return {
            announcement: "",
            error: "",
            requesting: false,
            activate: async (signal) => {
                const state = configurationStore.getState();
                if (state.configuration.kind !== "ready") {
                    return;
                }
                const selectedAgent = connection.agents.find((agent) => agent.id === state.agentRef);
                if (selectedAgent === undefined) {
                    set({ error: "Choose an available local Agent." });
                    return;
                }
                if (!state.identityOnly && state.instructions.trim().length === 0) {
                    set({ error: "Enter behavior instructions before activating the Bot." });
                    return;
                }
                if (!state.identityOnly && !selectedAgent.capabilities.embeddedContextPrompt) {
                    set({ error: `${selectedAgent.label} can run this Bot only in identity-only mode.` });
                    return;
                }
                if (state.workspaceRef.trim().length === 0) {
                    set({ error: "Enter a local workspace reference." });
                    return;
                }
                if (
                    state.completionSelection.kind === "required" &&
                    (!state.allowedDeliveryTargetIds.includes(state.completionSelection.targetId) ||
                        state.completionSelection.messageTemplate.trim().length === 0)
                ) {
                    set({ error: "Choose an allowed completion target and enter its message template." });
                    return;
                }
                set({ announcement: "", error: "", requesting: true });
                try {
                    const behaviorInstructions = state.identityOnly ? "" : state.instructions.trim();
                    const requiredCapabilities = state.identityOnly ? [] : ["embedded-context"];
                    const latestBehavior = state.configuration.behaviors[0];
                    const behavior =
                        latestBehavior !== undefined &&
                        latestBehavior.state.kind === "proposed" &&
                        latestBehavior.instructions === behaviorInstructions &&
                        latestBehavior.requiredCapabilities.length === requiredCapabilities.length &&
                        latestBehavior.requiredCapabilities.every(
                            (capability, index) => capability === requiredCapabilities[index],
                        ) &&
                        Object.keys(latestBehavior.agentConfiguration).length === 0
                            ? latestBehavior
                            : await client.createBehavior(
                                  bot.botId,
                                  {
                                      agentConfiguration: {},
                                      expectedRevision: latestBehavior?.revisionNumber ?? 0,
                                      instructions: behaviorInstructions,
                                      requiredCapabilities,
                                  },
                                  signal,
                              );
                    const accepted = await client.createBinding(
                        bot.botId,
                        {
                            agentConfigRevision: 1,
                            agentRef: state.agentRef,
                            allowedDeliveryTargetIds: state.allowedDeliveryTargetIds,
                            behaviorRevisionId: behavior.behaviorRevisionId,
                            completionPolicy:
                                state.completionSelection.kind === "required"
                                    ? new MobiusRequiredBotCompletionPolicy(
                                          state.completionSelection.targetId,
                                          state.completionSelection.messageTemplate.trim(),
                                      )
                                    : new MobiusNoBotCompletionPolicy(),
                            expectedRevision: bot.lifecycleRevision,
                            runtimeId: connection.runtimeId,
                            workspaceRef: state.workspaceRef.trim(),
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    set({
                        announcement: `Activation confirmed. ${connection.machineName} is validating the selected Agent and workspace.`,
                    });
                    await configurationStore.getState().load(signal);
                    await watch(accepted.bindingId, signal);
                } catch (error) {
                    if (!signal.aborted) {
                        await configurationStore.getState().load(signal);
                        set({ announcement: "", error: failureMessage(error) });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ requesting: false });
                    }
                }
            },
            open: async (signal) => {
                await configurationStore.getState().load(signal);
                const configuration = configurationStore.getState().configuration;
                if (configuration.kind !== "ready" || signal.aborted) {
                    return;
                }
                const pending = configuration.bindings.find((binding) => binding.state.kind === "requested");
                if (pending !== undefined) {
                    await watch(pending.bindingId, signal);
                }
            },
            syncBot: (nextBot) => {
                bot = nextBot;
            },
        };
    });
