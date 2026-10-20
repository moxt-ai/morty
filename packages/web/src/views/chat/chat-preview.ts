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
    interactive: "交互 playground（推荐）",
    "landing-disconnected": "落地页 · 未连接（无输入框）",
    "landing-composer": "落地页 · 已连接（含输入框）",
    conversation: "会话中（消息 + 输入框）",
    "setup-card": "Setup 卡片（配对说明）",
    "pairing-dialog": "配对弹窗 + Chat 壳",
};
