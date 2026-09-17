import {
    MobiusApiError,
    type MobiusBotBehaviorRevision,
    type MobiusBotExecutionBinding,
    type MobiusBotOwnerClient,
    type MobiusOwnerBotDeliveryTarget,
    MobiusRequiredBotCompletionPolicy,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import type { ChannelConnection } from "@/view-models/chat/channel";

type BotConfigurationState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "ready";
          readonly behaviors: readonly MobiusBotBehaviorRevision[];
          readonly bindings: readonly MobiusBotExecutionBinding[];
          readonly deliveryTargets: readonly MobiusOwnerBotDeliveryTarget[];
      }
    | { readonly kind: "failed"; readonly message: string };

type BotCompletionSelection =
    | { readonly kind: "none" }
    | { readonly kind: "required"; readonly messageTemplate: string; readonly targetId: string };

export interface BotConfigurationStore {
    readonly agentRef: string;
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly completionSelection: BotCompletionSelection;
    readonly configuration: BotConfigurationState;
    readonly identityOnly: boolean;
    readonly instructions: string;
    readonly refreshing: boolean;
    readonly workspaceRef: string;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly selectAgent: (agentRef: string) => void;
    readonly selectDeliveryTarget: (targetId: string, selected: boolean) => void;
    readonly selectIdentityOnly: (selected: boolean) => void;
    readonly setCompletionTarget: (targetId: string) => void;
    readonly setCompletionTemplate: (messageTemplate: string) => void;
    readonly setInstructions: (value: string) => void;
    readonly setWorkspaceRef: (value: string) => void;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot operation failed.";
}

export const createBotConfigurationStore = (
    botId: string,
    client: MobiusBotOwnerClient,
    connection: ChannelConnection,
) =>
    createStore<BotConfigurationStore>()((set, get) => {
        let behaviorDefaultsId = "";
        let bindingDefaultsId = "";
        return {
            agentRef:
                connection.agents.find((agent) => agent.capabilities.embeddedContextPrompt)?.id ??
                connection.agents[0]?.id ??
                "",
            allowedDeliveryTargetIds: [],
            completionSelection: { kind: "none" },
            configuration: { kind: "loading" },
            identityOnly: !connection.agents.some((agent) => agent.capabilities.embeddedContextPrompt),
            instructions: "",
            refreshing: false,
            workspaceRef: "default",
            load: async (signal) => {
                const current = get().configuration;
                set({ configuration: current.kind === "ready" ? current : { kind: "loading" }, refreshing: true });
                try {
                    const [behaviors, bindings, connections] = await Promise.all([
                        client.listBehaviors(botId, signal),
                        client.listBindings(botId, signal),
                        client.listConnections(botId, signal),
                    ]);
                    signal.throwIfAborted();
                    const deliveryTargets = connections.deliveryTargets.filter(
                        (target) => target.state.kind === "active" && target.ownerApproved,
                    );
                    const targetIds = new Set(deliveryTargets.map((target) => target.deliveryTargetId));
                    const approvedBinding = bindings.executionBindings.find(
                        (binding) => binding.state.kind === "approved",
                    );
                    if (approvedBinding !== undefined && bindingDefaultsId !== approvedBinding.bindingId) {
                        const allowedDeliveryTargetIds = approvedBinding.allowedDeliveryTargetIds.filter((targetId) =>
                            targetIds.has(targetId),
                        );
                        set({
                            agentRef: approvedBinding.agentRef,
                            allowedDeliveryTargetIds,
                            completionSelection:
                                approvedBinding.completionPolicy instanceof MobiusRequiredBotCompletionPolicy &&
                                allowedDeliveryTargetIds.includes(approvedBinding.completionPolicy.deliveryTargetId)
                                    ? {
                                          kind: "required",
                                          messageTemplate: approvedBinding.completionPolicy.messageTemplate,
                                          targetId: approvedBinding.completionPolicy.deliveryTargetId,
                                      }
                                    : { kind: "none" },
                            workspaceRef: approvedBinding.workspaceRef,
                        });
                        bindingDefaultsId = approvedBinding.bindingId;
                    } else {
                        const state = get();
                        set({
                            allowedDeliveryTargetIds: state.allowedDeliveryTargetIds.filter((targetId) =>
                                targetIds.has(targetId),
                            ),
                            completionSelection:
                                state.completionSelection.kind === "required" &&
                                !targetIds.has(state.completionSelection.targetId)
                                    ? { kind: "none" }
                                    : state.completionSelection,
                        });
                    }
                    const latest = behaviors.behaviorRevisions[0];
                    if (latest !== undefined && behaviorDefaultsId !== latest.behaviorRevisionId) {
                        set({
                            identityOnly: latest.instructions.length === 0 && latest.requiredCapabilities.length === 0,
                            instructions: latest.instructions,
                        });
                        behaviorDefaultsId = latest.behaviorRevisionId;
                    }
                    set({
                        configuration: {
                            behaviors: behaviors.behaviorRevisions,
                            bindings: bindings.executionBindings,
                            deliveryTargets,
                            kind: "ready",
                        },
                    });
                } catch (error) {
                    if (!signal.aborted) {
                        set({ configuration: { kind: "failed", message: failureMessage(error) } });
                    }
                } finally {
                    if (!signal.aborted) {
                        set({ refreshing: false });
                    }
                }
            },
            selectAgent: (agentRef) => {
                const agent = connection.agents.find((candidate) => candidate.id === agentRef);
                set({
                    agentRef,
                    identityOnly: agent?.capabilities.embeddedContextPrompt === false || get().identityOnly,
                });
            },
            selectDeliveryTarget: (targetId, selected) => {
                const state = get();
                set({
                    allowedDeliveryTargetIds: selected
                        ? [...state.allowedDeliveryTargetIds, targetId]
                        : state.allowedDeliveryTargetIds.filter((candidate) => candidate !== targetId),
                    completionSelection:
                        !selected &&
                        state.completionSelection.kind === "required" &&
                        state.completionSelection.targetId === targetId
                            ? { kind: "none" }
                            : state.completionSelection,
                });
            },
            selectIdentityOnly: (identityOnly) => {
                const agent = connection.agents.find((candidate) => candidate.id === get().agentRef);
                if (identityOnly || agent?.capabilities.embeddedContextPrompt === true) {
                    set({ identityOnly });
                }
            },
            setCompletionTarget: (targetId) => {
                const selection = get().completionSelection;
                set({
                    completionSelection:
                        targetId.length === 0
                            ? { kind: "none" }
                            : {
                                  kind: "required",
                                  messageTemplate:
                                      selection.kind === "required" ? selection.messageTemplate : "Turn {status}",
                                  targetId,
                              },
                });
            },
            setCompletionTemplate: (messageTemplate) => {
                const selection = get().completionSelection;
                if (selection.kind === "required") {
                    set({ completionSelection: { ...selection, messageTemplate } });
                }
            },
            setInstructions: (instructions) => set({ instructions }),
            setWorkspaceRef: (workspaceRef) => set({ workspaceRef }),
        };
    });

export function formatBotDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function botBehaviorStatusLabel(behavior: MobiusBotBehaviorRevision): string {
    if (behavior.state.kind === "awaiting_local_approval") {
        return "Activating";
    }
    if (behavior.state.kind === "approved") {
        return "Approved";
    }
    if (behavior.state.kind === "retired") {
        return "Retired";
    }
    return "Proposed";
}

export function botBindingStatusLabel(binding: MobiusBotExecutionBinding): string {
    if (binding.state.kind === "requested") {
        return "Activating";
    }
    if (binding.state.kind === "approved") {
        return "Approved";
    }
    if (binding.state.kind === "unavailable") {
        return "Unavailable";
    }
    return "Revoked";
}
