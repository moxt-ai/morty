import type { SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import {
    type AgentSettingPreference,
    centralSessionStorage,
    lastAgentSettingsEntry,
} from "@/services/session-storage/central-session-storage";

export function restoreLastAgentSettings(
    botId: string,
    agentRef: string,
    options: readonly SessionConfigOption[],
): { readonly options: readonly SessionConfigOption[]; readonly restoredIds: ReadonlySet<string> } {
    const preferences = centralSessionStorage.read(lastAgentSettingsEntry(botId, agentRef)) ?? [];
    const restoredIds = new Set<string>();
    const restored = options.map((option) => {
        const preference = preferences.find((candidate) => candidate.configId === option.id);
        if (option.type === "boolean" && preference?.kind === "boolean") {
            restoredIds.add(option.id);
            return { ...option, booleanValue: preference.value };
        }
        if (
            option.type === "select" &&
            preference?.kind === "select" &&
            option.values.some((value) => value.value === preference.value)
        ) {
            restoredIds.add(option.id);
            return { ...option, currentValue: preference.value };
        }
        return option;
    });
    return { options: restored, restoredIds };
}

export function saveLastAgentSettings(botId: string, agentRef: string, options: readonly SessionConfigOption[]): void {
    const preferences: readonly AgentSettingPreference[] = options.map((option) =>
        option.type === "boolean"
            ? { configId: option.id, kind: "boolean", value: option.booleanValue }
            : { configId: option.id, kind: "select", value: option.currentValue },
    );
    centralSessionStorage.write(lastAgentSettingsEntry(botId, agentRef), preferences);
}
