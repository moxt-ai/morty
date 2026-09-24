import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { centralLocalStorage, selectedBotEntry } from "@/services/local-storage/central-local-storage";

export interface SelectedBotPreference {
    readonly read: () => string | null;
    readonly write: (botId: string) => void;
}

export function createSelectedBotPreference(projectId: string): SelectedBotPreference {
    return {
        read: () => centralLocalStorage.read(selectedBotEntry(projectId)),
        write: (botId) => {
            if (!isIdentifier(botId)) {
                return;
            }
            centralLocalStorage.write(selectedBotEntry(projectId), botId);
        },
    };
}
