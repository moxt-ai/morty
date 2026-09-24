import {
    centralLocalStorage,
    lastCwdEntry,
    type RecentCwdPreference,
    recentCwdEntry,
} from "@/services/local-storage/central-local-storage";

const MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH = 1_000;
const MAXIMUM_DIRECTORY_LABEL_LENGTH = 4_000;

export type { RecentCwdPreference };

export function readRecentCwdPreferences(botId: string): readonly RecentCwdPreference[] | null {
    return centralLocalStorage.read(recentCwdEntry(botId));
}

export function saveRecentCwdPreference(
    botId: string,
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
    ].slice(0, 10);
    centralLocalStorage.write(recentCwdEntry(botId), recent);
    return recent;
}

export function forgetRecentCwdPreference(
    botId: string,
    directoryId: string,
    existing: readonly RecentCwdPreference[],
): readonly RecentCwdPreference[] {
    const recent = existing.filter((preference) => preference.directoryId !== directoryId);
    centralLocalStorage.write(recentCwdEntry(botId), recent);
    return recent;
}

export function readLastCwdPreference(botId: string, runtimeId: string, agentRef: string): string | null {
    return centralLocalStorage.read(lastCwdEntry(botId, runtimeId, agentRef));
}

export function saveLastCwdPreference(botId: string, runtimeId: string, agentRef: string, directoryId: string): void {
    if (directoryId.length === 0 || directoryId.length > MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH) {
        return;
    }
    centralLocalStorage.write(lastCwdEntry(botId, runtimeId, agentRef), directoryId);
}
