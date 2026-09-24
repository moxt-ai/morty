import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import {
    centralLocalStorage,
    legacySessionModelPreferencesEntry,
    type StoredSessionConfigPreference,
    sessionConfigPreferencesEntry,
} from "@/services/local-storage/central-local-storage";

function preferenceFromOption(option: SessionConfigOption): StoredSessionConfigPreference {
    return option.type === "boolean"
        ? { booleanValue: option.booleanValue, configId: option.id, valueType: "boolean" }
        : { configId: option.id, value: option.currentValue, valueType: "select" };
}

export function readSessionConfigPreferences(
    channelId: string,
    agentId: string,
): readonly StoredSessionConfigPreference[] {
    const preferences = centralLocalStorage.read(sessionConfigPreferencesEntry(channelId, agentId));
    if (preferences !== null && preferences.length > 0) {
        return preferences;
    }
    return centralLocalStorage.read(legacySessionModelPreferencesEntry(channelId, agentId)) ?? [];
}

export function saveSessionConfigPreferences(
    channelId: string,
    agentId: string,
    options: readonly SessionConfigOption[],
): void {
    const preferences = options.map(preferenceFromOption);
    if (preferences.length === 0) {
        return;
    }
    centralLocalStorage.write(sessionConfigPreferencesEntry(channelId, agentId), preferences);
    centralLocalStorage.remove(legacySessionModelPreferencesEntry(channelId, agentId));
}
