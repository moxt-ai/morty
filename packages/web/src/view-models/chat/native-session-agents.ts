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
