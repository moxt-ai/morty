// TEMP style-tuning preview: remove with chat preview routes.

import type { SessionMessage } from "../../view-models/chat/session-presentation.ts";
import { createMessageTypesShowcase, previewAssistantText, previewUserText } from "./chat-preview-session-messages.ts";

export type PreviewSessionStatus = "idle" | "working" | "failed" | "unread";

export type PreviewSession = {
    readonly id: string;
    readonly title: string;
    readonly directoryLabel: string;
    readonly updatedAt: Date;
    readonly status: PreviewSessionStatus;
    readonly messages: readonly SessionMessage[];
};

export const CHAT_PREVIEW_DRAFT_ID = "__draft__";

function session(
    id: string,
    title: string,
    directoryLabel: string,
    updatedAt: Date,
    status: PreviewSessionStatus,
    messages: readonly SessionMessage[],
): PreviewSession {
    return { id, title, directoryLabel, updatedAt, status, messages };
}

const now = new Date("2026-10-20T10:30:00+08:00");

export function createInitialPreviewSessions(): PreviewSession[] {
    return [
        session(
            "preview-session-message-types",
            "Message types showcase",
            "~/morty/packages/web",
            new Date(now.getTime() - 5 * 60_000),
            "idle",
            createMessageTypesShowcase("preview-session-message-types"),
        ),
        session(
            "preview-session-1",
            "Refactor sidebar spacing",
            "~/morty",
            new Date(now.getTime() - 20 * 60_000),
            "idle",
            [
                previewUserText(
                    "m1",
                    "preview-session-1",
                    "Help me tighten spacing on the chat sidebar and message bubbles.",
                ),
                previewAssistantText(
                    "m2",
                    "preview-session-1",
                    "Start with `conversation-sidebar.tsx` for the session list and `user-prompt-message.tsx` for bubble radii.",
                ),
            ],
        ),
        session(
            "preview-session-2",
            "Update chat composer styles",
            "~/morty/packages/web",
            new Date(now.getTime() - 55 * 60_000),
            "unread",
            [
                previewUserText("m3", "preview-session-2", "The composer focus ring feels too strong on mobile."),
                previewAssistantText(
                    "m4",
                    "preview-session-2",
                    "Try lowering the shadow on `focus-within` in `bot-chat-composer.tsx` and compare at 375px width.",
                ),
            ],
        ),
        session(
            "preview-session-3",
            "Pairing instruction layout",
            "~/morty/packages/web",
            new Date(now.getTime() - 3 * 60 * 60_000),
            "idle",
            [previewUserText("m5", "preview-session-3", "Can we align setup copy with the continue page?")],
        ),
        session(
            "preview-session-4",
            "Dark mode pass",
            "~/morty",
            new Date(now.getTime() - 26 * 60 * 60_000),
            "failed",
            [
                previewUserText("m6", "preview-session-4", "Audit sidebar contrast in dark theme."),
                previewAssistantText("m7", "preview-session-4", "Runtime disconnected before this reply finished."),
            ],
        ),
        session(
            "preview-session-5",
            "Empty thread placeholder",
            "~/workspace/demo",
            new Date(now.getTime() - 5 * 24 * 60 * 60_000),
            "idle",
            [],
        ),
    ];
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function localCalendarDay(date: Date): number {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function previewSessionGroupLabel(updatedAt: Date, reference: Date): string {
    const daysAgo = Math.floor((localCalendarDay(reference) - localCalendarDay(updatedAt)) / DAY_MS);
    if (daysAgo <= 0) {
        return "Today";
    }
    if (daysAgo === 1) {
        return "Yesterday";
    }
    if (daysAgo <= 7) {
        return "Previous 7 Days";
    }
    return "Older";
}

export function groupPreviewSessions(
    sessions: readonly PreviewSession[],
    reference: Date,
): { readonly label: string; readonly sessions: readonly PreviewSession[] }[] {
    const groups = new Map<string, PreviewSession[]>();
    for (const item of sessions) {
        const label = previewSessionGroupLabel(item.updatedAt, reference);
        const bucket = groups.get(label);
        if (bucket === undefined) {
            groups.set(label, [item]);
        } else {
            bucket.push(item);
        }
    }
    const order = ["Today", "Yesterday", "Previous 7 Days", "Older"];
    return order
        .filter((label) => groups.has(label))
        .map((label) => ({
            label,
            sessions: [...(groups.get(label) ?? [])].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
        }));
}

export function previewAssistantReply(userText: string): string {
    const trimmed = userText.trim();
    if (trimmed.length === 0) {
        return "Send a message to preview assistant styling.";
    }
    return `Preview reply for: “${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}”. Adjust spacing in the message column and re-check this thread.`;
}
