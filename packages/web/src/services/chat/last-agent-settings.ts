import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";

const LAST_AGENT_SETTINGS_PREFIX = "mobius:last-agent-settings:v1:";
const MAXIMUM_SETTING_COUNT = 100;
const MAXIMUM_SETTING_IDENTIFIER_LENGTH = 128;
const MAXIMUM_SETTING_VALUE_LENGTH = 500;

type AgentSettingPreference =
    | { readonly configId: string; readonly kind: "boolean"; readonly value: boolean }
    | { readonly configId: string; readonly kind: "select"; readonly value: string };

function storageKey(botId: string, agentRef: string): string {
    return `${LAST_AGENT_SETTINGS_PREFIX}${encodeURIComponent(botId)}:${encodeURIComponent(agentRef)}`;
}

function decodePreference(value: unknown): AgentSettingPreference | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const configId = Reflect.get(value, "configId");
    const kind = Reflect.get(value, "kind");
    const preference = Reflect.get(value, "value");
    if (typeof configId !== "string" || configId.length === 0 || configId.length > MAXIMUM_SETTING_IDENTIFIER_LENGTH) {
        return null;
    }
    if (kind === "boolean" && typeof preference === "boolean") {
        return { configId, kind, value: preference };
    }
    if (kind === "select" && typeof preference === "string" && preference.length <= MAXIMUM_SETTING_VALUE_LENGTH) {
        return { configId, kind, value: preference };
    }
    return null;
}

function readPreferences(storage: Storage, botId: string, agentRef: string): readonly AgentSettingPreference[] {
    try {
        const encoded = storage.getItem(storageKey(botId, agentRef));
        if (encoded === null) {
            return [];
        }
        const decoded: unknown = JSON.parse(encoded);
        if (!Array.isArray(decoded) || decoded.length > MAXIMUM_SETTING_COUNT) {
            return [];
        }
        const preferences: AgentSettingPreference[] = [];
        for (const value of decoded) {
            const preference = decodePreference(value);
            if (preference === null || preferences.some((item) => item.configId === preference.configId)) {
                return [];
            }
            preferences.push(preference);
        }
        return preferences;
    } catch {
        return [];
    }
}

export function restoreLastAgentSettings(
    storage: Storage,
    botId: string,
    agentRef: string,
    options: readonly SessionConfigOption[],
): { readonly options: readonly SessionConfigOption[]; readonly restoredIds: ReadonlySet<string> } {
    const preferences = readPreferences(storage, botId, agentRef);
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

export function saveLastAgentSettings(
    storage: Storage,
    botId: string,
    agentRef: string,
    options: readonly SessionConfigOption[],
): void {
    const preferences: readonly AgentSettingPreference[] = options.map((option) =>
        option.type === "boolean"
            ? { configId: option.id, kind: "boolean", value: option.booleanValue }
            : { configId: option.id, kind: "select", value: option.currentValue },
    );
    try {
        storage.setItem(storageKey(botId, agentRef), JSON.stringify(preferences));
    } catch {}
}
