const LAST_CWD_PREFERENCE_PREFIX = "mobius:last-cwd:";
const RECENT_CWD_PREFERENCE_PREFIX = "mobius:recent-cwd:";
const MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH = 1_000;
const MAXIMUM_DIRECTORY_LABEL_LENGTH = 4_000;

const MAXIMUM_RECENT_CWD_COUNT = 10;

export interface RecentCwdPreference {
    readonly directoryId: string;
    readonly directoryLabel: string;
}

function storageKey(botId: string, runtimeId: string, agentRef: string): string {
    return `${LAST_CWD_PREFERENCE_PREFIX}${encodeURIComponent(botId)}:${encodeURIComponent(runtimeId)}:${encodeURIComponent(agentRef)}`;
}

function recentStorageKey(botId: string, runtimeId: string, agentRef: string): string {
    return `${RECENT_CWD_PREFERENCE_PREFIX}${encodeURIComponent(botId)}:${encodeURIComponent(runtimeId)}:${encodeURIComponent(agentRef)}`;
}

function decodeRecentCwdPreferences(encoded: string): readonly RecentCwdPreference[] {
    try {
        const decoded: unknown = JSON.parse(encoded);
        if (!Array.isArray(decoded) || decoded.length > MAXIMUM_RECENT_CWD_COUNT) {
            return [];
        }
        const preferences: RecentCwdPreference[] = [];
        for (const item of decoded) {
            if (typeof item !== "object" || item === null) {
                return [];
            }
            const directoryId = Reflect.get(item, "directoryId");
            const directoryLabel = Reflect.get(item, "directoryLabel");
            if (
                typeof directoryId !== "string" ||
                directoryId.length === 0 ||
                directoryId.length > MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH ||
                typeof directoryLabel !== "string" ||
                directoryLabel.length === 0 ||
                directoryLabel.length > MAXIMUM_DIRECTORY_LABEL_LENGTH ||
                preferences.some((preference) => preference.directoryId === directoryId)
            ) {
                return [];
            }
            preferences.push({ directoryId, directoryLabel });
        }
        return preferences;
    } catch {
        return [];
    }
}

function writeRecentCwdPreferences(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
    recent: readonly RecentCwdPreference[],
): void {
    try {
        storage.setItem(recentStorageKey(botId, runtimeId, agentRef), JSON.stringify(recent));
    } catch {}
}

export function readRecentCwdPreferences(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
): readonly RecentCwdPreference[] | null {
    try {
        const encoded = storage.getItem(recentStorageKey(botId, runtimeId, agentRef));
        return encoded === null ? null : decodeRecentCwdPreferences(encoded);
    } catch {
        return null;
    }
}

export function saveRecentCwdPreference(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
    directory: RecentCwdPreference,
    existing: readonly RecentCwdPreference[],
): readonly RecentCwdPreference[] {
    if (
        directory.directoryId.length === 0 ||
        directory.directoryId.length > MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH ||
        directory.directoryLabel.length === 0 ||
        directory.directoryLabel.length > MAXIMUM_DIRECTORY_LABEL_LENGTH
    ) {
        return existing;
    }
    const recent = [
        directory,
        ...existing.filter((preference) => preference.directoryId !== directory.directoryId),
    ].slice(0, MAXIMUM_RECENT_CWD_COUNT);
    writeRecentCwdPreferences(storage, botId, runtimeId, agentRef, recent);
    return recent;
}

export function forgetRecentCwdPreference(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
    directoryId: string,
    existing: readonly RecentCwdPreference[],
): readonly RecentCwdPreference[] {
    const recent = existing.filter((preference) => preference.directoryId !== directoryId);
    writeRecentCwdPreferences(storage, botId, runtimeId, agentRef, recent);
    return recent;
}

export function readLastCwdPreference(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
): string | null {
    try {
        const directoryId = storage.getItem(storageKey(botId, runtimeId, agentRef));
        return directoryId !== null &&
            directoryId.length > 0 &&
            directoryId.length <= MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH
            ? directoryId
            : null;
    } catch {
        return null;
    }
}

export function saveLastCwdPreference(
    storage: Storage,
    botId: string,
    runtimeId: string,
    agentRef: string,
    directoryId: string,
): void {
    if (directoryId.length === 0 || directoryId.length > MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH) {
        return;
    }
    try {
        storage.setItem(storageKey(botId, runtimeId, agentRef), directoryId);
    } catch {}
}
