import { centralLocalStorage, lastHarnessEntry } from "@/services/local-storage/central-local-storage";

/**
 * The Agent reference identifies the computer's preferred harness across
 * Runtime reconnects and pairing.
 */
export function readLastHarnessPreference(computerId: string): string | null {
    return centralLocalStorage.read(lastHarnessEntry(computerId));
}

export function saveLastHarnessPreference(computerId: string, agentRef: string): void {
    centralLocalStorage.write(lastHarnessEntry(computerId), agentRef);
}
