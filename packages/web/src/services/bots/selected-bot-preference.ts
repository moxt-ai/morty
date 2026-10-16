import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { centralSessionStorage, selectedBotEntry } from "@/services/session-storage/central-session-storage";

export interface SelectedBotPreference {
    readonly read: () => string | null;
    readonly write: (botId: string) => void;
}

export function createSelectedBotPreference(projectId: string): SelectedBotPreference {
    return {
        read: () => centralSessionStorage.read(selectedBotEntry(projectId)),
        write: (botId) => {
            if (!isIdentifier(botId)) {
                return;
            }
            centralSessionStorage.write(selectedBotEntry(projectId), botId);
        },
    };
}
