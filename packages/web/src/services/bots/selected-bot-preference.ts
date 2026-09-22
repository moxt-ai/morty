const SELECTED_BOT_KEY_PREFIX = "mobius.chat.selectedBot.v1:";
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export interface SelectedBotPreference {
    readonly read: () => string | null;
    readonly write: (botId: string) => void;
}

export function createSelectedBotPreference(storage: Storage, projectId: string): SelectedBotPreference {
    const key = `${SELECTED_BOT_KEY_PREFIX}${encodeURIComponent(projectId)}`;
    return {
        read: () => {
            try {
                const botId = storage.getItem(key);
                return botId !== null && identifierPattern.test(botId) ? botId : null;
            } catch {
                return null;
            }
        },
        write: (botId) => {
            if (!identifierPattern.test(botId)) {
                return;
            }
            try {
                storage.setItem(key, botId);
            } catch {
                // Selection remains usable for this page when browser storage is unavailable.
            }
        },
    };
}
