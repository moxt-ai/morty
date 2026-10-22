import { centralLocalStorage, lastHarnessEntry } from "@/services/local-storage/central-local-storage";

/**
 * The Agent reference, not the Runtime identifier, identifies the harness a
 * Bot works in: a Bot talks to one Runtime at a time, so the same Agent keeps
 * its identity when the Runtime reconnects or the Bot pairs again.
 */
export function readLastHarnessPreference(botId: string): string | null {
    return centralLocalStorage.read(lastHarnessEntry(botId));
}

export function saveLastHarnessPreference(botId: string, agentRef: string): void {
    centralLocalStorage.write(lastHarnessEntry(botId), agentRef);
}

export function clearLastHarnessPreference(botId: string): void {
    centralLocalStorage.remove(lastHarnessEntry(botId));
}
