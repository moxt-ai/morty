const LAST_CWD_PREFERENCE_PREFIX = "mobius:last-cwd:";
const MAXIMUM_DIRECTORY_IDENTIFIER_LENGTH = 1_000;

function storageKey(botId: string, runtimeId: string, agentRef: string): string {
    return `${LAST_CWD_PREFERENCE_PREFIX}${encodeURIComponent(botId)}:${encodeURIComponent(runtimeId)}:${encodeURIComponent(agentRef)}`;
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
