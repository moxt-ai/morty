import { decodeIdentifier, type Identifier } from "@morty-build/client/protocol";
import {
    type ChatAgentSelection,
    type ChatRuntime,
    connectedChatRuntimeAgents,
} from "../../services/chat/bot-chat-api.ts";

export type NativeSessionAgent = ChatAgentSelection & { readonly installed: boolean; readonly value: string };

export function harnessValue(computerId: string, harness: string): string {
    return `${computerId}:${harness}`;
}

const PI_HARNESS: Identifier = decodeIdentifier("pi");

/** Runtime harness tabs: connected agents plus Pi when it is not on the Runtime. */
export function nativeSessionAgentTabs(runtime: ChatRuntime): readonly NativeSessionAgent[] {
    const connected = connectedChatRuntimeAgents(runtime);
    const installed = connected.map((agent) => ({
        ...agent,
        installed: true as const,
        value: harnessValue(agent.computerId, agent.harness),
    }));
    if (connected.length === 0 || connected.some((agent) => agent.harness === PI_HARNESS)) {
        return installed;
    }
    const anchor = connected.at(0);
    if (anchor === undefined) {
        return installed;
    }
    return [
        ...installed,
        {
            computerId: anchor.computerId,
            machineName: anchor.machineName,
            harness: PI_HARNESS,
            label: "Pi",
            installed: false,
            value: harnessValue(anchor.computerId, PI_HARNESS),
        },
    ];
}

/** A harness the configuration menu offers, as the Runtime configuration names it. */
export interface HarnessOption {
    readonly harness: string;
    readonly installed: boolean;
    readonly label: string;
    readonly tabLabel: string;
    readonly value: string;
}

/** The harnesses a configuration menu offers, derived from the Runtime configuration the page follows. */
export function harnessOptions(runtime: ChatRuntime | null): readonly HarnessOption[] {
    return (runtime === null ? [] : nativeSessionAgentTabs(runtime)).map((agent) => ({
        harness: agent.harness,
        installed: agent.installed,
        label: agent.label,
        tabLabel: agent.label,
        value: agent.value,
    }));
}

/** Existing sessions keep their Agent even if the Runtime no longer offers it. */
export function sessionHarnessSelection(runtime: ChatRuntime | null, harness: string) {
    const options = harnessOptions(runtime);
    const selected = options.find((option) => option.harness === harness);
    if (selected !== undefined) {
        return { options, value: selected.value };
    }
    const fallback: HarnessOption = {
        harness,
        installed: false,
        label: harness,
        tabLabel: harness,
        value: harnessValue(runtime?.computerId ?? "", harness),
    };
    return { options: [...options, fallback], value: fallback.value };
}
