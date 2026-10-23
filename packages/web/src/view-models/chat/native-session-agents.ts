import { decodeIdentifier, type Identifier } from "@moxt-ai/mobius-sdk/protocol";
import {
    type ChatAgentSelection,
    type ChatRuntime,
    connectedChatRuntimeAgents,
} from "../../services/chat/bot-chat-api.ts";

export type NativeSessionAgent = ChatAgentSelection & { readonly installed: boolean };

const PI_AGENT_REF: Identifier = decodeIdentifier("pi");

/** Runtime harness tabs: connected agents plus Pi when it is not on the Runtime. */
export function nativeSessionAgentTabs(runtime: ChatRuntime): readonly NativeSessionAgent[] {
    const connected = connectedChatRuntimeAgents(runtime);
    const installed = connected.map((agent) => ({ ...agent, installed: true as const }));
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
        value: `${agent.runtimeId}:${agent.agentRef}`,
    }));
}
