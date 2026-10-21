// TEMP style-tuning preview: remove this module with chat preview routes.

export const CHAT_PREVIEW_STATES = [
    "interactive",
    "landing-disconnected",
    "landing-composer",
    "conversation",
    "setup-card",
    "pairing-dialog",
] as const;

export type ChatPreviewStateId = (typeof CHAT_PREVIEW_STATES)[number];

export function isChatPreviewStateId(value: string): value is ChatPreviewStateId {
    return (CHAT_PREVIEW_STATES as readonly string[]).includes(value);
}

export const CHAT_PREVIEW_STATE_LABELS: Record<ChatPreviewStateId, string> = {
    interactive: "Interactive playground (recommended)",
    "landing-disconnected": "Landing, disconnected (no composer)",
    "landing-composer": "Landing, connected (with composer)",
    conversation: "In conversation (messages and composer)",
    "setup-card": "Setup card (pairing instructions)",
    "pairing-dialog": "Pairing dialog and chat shell",
};
