export const MAX_FORMATTED_TOOL_TEXT_CHARACTERS = 32 * 1024;
export const TOOL_TEXT_TAIL_CHARACTERS = MAX_FORMATTED_TOOL_TEXT_CHARACTERS / 2;

export function isOversizedToolText(text: string): boolean {
    return text.length > MAX_FORMATTED_TOOL_TEXT_CHARACTERS;
}
