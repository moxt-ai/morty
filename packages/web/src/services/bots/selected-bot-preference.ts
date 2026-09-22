import { centralLocalStorage, selectedBotEntry } from "@/services/local-storage/central-local-storage";

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export interface SelectedBotPreference {
    readonly read: () => string | null;
    readonly write: (botId: string) => void;
}

export function createSelectedBotPreference(projectId: string): SelectedBotPreference {
    return {
        read: () => centralLocalStorage.read(selectedBotEntry(projectId)),
        write: (botId) => {
            if (!identifierPattern.test(botId)) {
                return;
            }
            centralLocalStorage.write(selectedBotEntry(projectId), botId);
        },
    };
}
