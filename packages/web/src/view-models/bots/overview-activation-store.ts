import {
    DEFAULT_AGENT_EXECUTION_CONFIGURATION,
    MobiusApiError,
    type MobiusBot,
    type MobiusBotOwnerClient,
    MobiusNoBotCompletionPolicy,
    MobiusRequiredBotCompletionPolicy,
} from "@moxt-ai/mobius-sdk";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { BotConfigurationStore } from "@/view-models/bots/overview-configuration-store";
import type { ChannelConnection } from "@/view-models/chat/channel";

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

export const createBotActivationStore = (
    initialBot: MobiusBot,
    client: MobiusBotOwnerClient,
    connection: ChannelConnection,
    configurationStore: StoreApi<BotConfigurationStore>,
    refreshBot: () => Promise<MobiusBot>,
) =>
    createStore<BotActivationStore>()((set) => {
        let bot = initialBot;

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
                    await client.createBinding(
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
                            executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                            expectedRevision: bot.lifecycleRevision,
                            runtimeId: connection.runtimeId,
                            workspaceRef: state.workspaceRef.trim(),
                        },
                        signal,
                    );
                    signal.throwIfAborted();
                    await configurationStore.getState().load(signal);
                    signal.throwIfAborted();
                    bot = await refreshBot();
                    set({ announcement: `Bot activated on ${connection.machineName}.` });
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
            },
            syncBot: (nextBot) => {
                bot = nextBot;
            },
        };
    });
