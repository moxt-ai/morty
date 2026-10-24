import { isDirectoryIdentifier, MAX_WORKSPACE_PATH_LENGTH } from "@moxt-ai/mobius-sdk/protocol";
import {
    centralLocalStorage,
    lastCwdEntry,
    type RecentCwdPreference,
    recentCwdEntry,
} from "@/services/local-storage/central-local-storage";

export type { RecentCwdPreference };

export function readRecentCwdPreferences(botId: string): readonly RecentCwdPreference[] | null {
    return centralLocalStorage.read(recentCwdEntry(botId));
}

/**
 * Storage owns the recent directories, which every tab of the Bot shares: a change starts from what storage holds now,
 * never from a copy a tab read earlier, so it cannot drop or bring back another tab's change.
 */
export function saveRecentCwdPreference(botId: string, directory: RecentCwdPreference): readonly RecentCwdPreference[] {
    const existing = readRecentCwdPreferences(botId) ?? [];
    if (
        !isDirectoryIdentifier(directory.directoryId) ||
        directory.directoryLabel.length === 0 ||
        directory.directoryLabel.length > MAX_WORKSPACE_PATH_LENGTH
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

export function forgetRecentCwdPreference(botId: string, directoryId: string): readonly RecentCwdPreference[] {
    const recent = (readRecentCwdPreferences(botId) ?? []).filter(
        (preference) => preference.directoryId !== directoryId,
    );
    centralLocalStorage.write(recentCwdEntry(botId), recent);
    return recent;
}

export function readLastCwdPreference(botId: string, runtimeId: string, agentRef: string): string | null {
    return centralLocalStorage.read(lastCwdEntry(botId, runtimeId, agentRef));
}

export function saveLastCwdPreference(botId: string, runtimeId: string, agentRef: string, directoryId: string): void {
    if (!isDirectoryIdentifier(directoryId)) {
        return;
    }
    centralLocalStorage.write(lastCwdEntry(botId, runtimeId, agentRef), directoryId);
}
