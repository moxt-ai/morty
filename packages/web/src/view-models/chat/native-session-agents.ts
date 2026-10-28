import { decodeIdentifier, type Identifier } from "@moxt-ai/mobius-sdk/protocol";
import {
    type ChatAgentSelection,
    type ChatRuntime,
    connectedChatRuntimeAgents,
} from "../../services/chat/bot-chat-api.ts";

export type NativeSessionAgent = ChatAgentSelection & { readonly installed: boolean; readonly value: string };

export function harnessValue(runtimeId: string, agentRef: string): string {
    return `${runtimeId}:${agentRef}`;
}

const PI_AGENT_REF: Identifier = decodeIdentifier("pi");

/** Runtime harness tabs: connected agents plus Pi when it is not on the Runtime. */
export function nativeSessionAgentTabs(runtime: ChatRuntime): readonly NativeSessionAgent[] {
    const connected = connectedChatRuntimeAgents(runtime);
    const installed = connected.map((agent) => ({
        ...agent,
        installed: true as const,
        value: harnessValue(agent.runtimeId, agent.agentRef),
    }));
    if (connected.length === 0 || connected.some((agent) => agent.agentRef === PI_AGENT_REF)) {
        return installed;
    }
    const anchor = connected.at(0);
    if (anchor === undefined) {
        return installed;
    }
    return [
        ...installed,
        {
            runtimeId: anchor.runtimeId,
            machineName: anchor.machineName,
            agentRef: PI_AGENT_REF,
            label: "Pi",
            installed: false,
            value: harnessValue(anchor.runtimeId, PI_AGENT_REF),
        },
    ];
}

/** A harness the configuration menu offers, as the Runtime configuration names it. */
export interface HarnessOption {
    readonly agentRef: string;
    readonly installed: boolean;
    readonly label: string;
    readonly tabLabel: string;
    readonly value: string;
}

/** The harnesses a configuration menu offers, derived from the Runtime configuration the page follows. */
export function harnessOptions(runtime: ChatRuntime | null): readonly HarnessOption[] {
    return (runtime === null ? [] : nativeSessionAgentTabs(runtime)).map((agent) => ({
        agentRef: agent.agentRef,
        installed: agent.installed,
        label: agent.label,
        tabLabel: agent.label,
        value: agent.value,
    }));
}

/** Existing sessions keep their Agent even if the Runtime no longer offers it. */
export function sessionHarnessSelection(runtime: ChatRuntime | null, agentRef: string) {
    const options = harnessOptions(runtime);
    const selected = options.find((option) => option.agentRef === agentRef);
    if (selected !== undefined) {
        return { options, value: selected.value };
    }
    const fallback: HarnessOption = {
        agentRef,
        installed: false,
        label: agentRef,
        tabLabel: agentRef,
        value: harnessValue(runtime?.runtimeId ?? "", agentRef),
    };
    return { options: [...options, fallback], value: fallback.value };
}
