import { isDirectoryIdentifier, MAX_WORKSPACE_PATH_LENGTH } from "@morty-build/client/protocol";
import {
    centralLocalStorage,
    lastCwdEntry,
    type RecentCwdPreference,
    recentCwdEntry,
} from "@/services/local-storage/central-local-storage";

export type { RecentCwdPreference };

export function readRecentCwdPreferences(computerId: string): readonly RecentCwdPreference[] | null {
    return centralLocalStorage.read(recentCwdEntry(computerId));
}

/**
 * Storage owns the recent directories, which every tab of the computer shares: a change starts from what storage holds now,
 * never from a copy a tab read earlier, so it cannot drop or bring back another tab's change.
 */
export function saveRecentCwdPreference(
    computerId: string,
    directory: RecentCwdPreference,
): readonly RecentCwdPreference[] {
    const existing = readRecentCwdPreferences(computerId) ?? [];
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
    centralLocalStorage.write(recentCwdEntry(computerId), recent);
    return recent;
}

export function forgetRecentCwdPreference(computerId: string, directoryId: string): readonly RecentCwdPreference[] {
    const recent = (readRecentCwdPreferences(computerId) ?? []).filter(
        (preference) => preference.directoryId !== directoryId,
    );
    centralLocalStorage.write(recentCwdEntry(computerId), recent);
    return recent;
}

export function readLastCwdPreference(computerId: string, agentRef: string): string | null {
    return centralLocalStorage.read(lastCwdEntry(computerId, agentRef));
}

export function saveLastCwdPreference(computerId: string, agentRef: string, directoryId: string): void {
    if (!isDirectoryIdentifier(directoryId)) {
        return;
    }
    centralLocalStorage.write(lastCwdEntry(computerId, agentRef), directoryId);
}
