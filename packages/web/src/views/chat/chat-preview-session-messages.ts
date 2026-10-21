// TEMP style-tuning preview: remove with chat preview routes.

import type { ContentBlock, SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { AgentDisplayContent } from "../../view-models/chat/display-content.ts";
import type {
    SessionMessage,
    SessionText,
    SessionToolPresentation,
} from "../../view-models/chat/session-presentation.ts";

const PREVIEW_FIXTURE_GENERATION_ID = "preview-fixture-generation";
const PREVIEW_RECORDED_AT = "2026-10-20T02:30:00.000+00:00";

/** 1×1 PNG */
const PREVIEW_TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function previewSessionEvent(eventId: string, sessionId: string): SessionEvent {
    return {
        eventId,
        payload: {
            content: { text: "", type: "text" },
            messageId: null,
            sessionUpdate: "agent_message_chunk",
        },
        recordedAt: PREVIEW_RECORDED_AT,
        sessionGenerationId: PREVIEW_FIXTURE_GENERATION_ID,
        sessionId,
        type: "acp",
    };
}

function previewSessionText(value: string, truncated = false): SessionText {
    return { kind: "initial", length: value.length, truncated, value };
}

function previewUserMessage(
    eventId: string,
    sessionId: string,
    contents: readonly ContentBlock[],
    commandId: string | null = null,
): SessionMessage {
    return {
        commandId,
        contents,
        firstEvent: previewSessionEvent(eventId, sessionId),
        role: "user",
    };
}

export function previewUserText(eventId: string, sessionId: string, text: string): SessionMessage {
    return previewUserMessage(eventId, sessionId, [{ text, type: "text" }]);
}

function previewAssistantMessage(
    eventId: string,
    sessionId: string,
    presentation: Extract<SessionMessage, { readonly role: "assistant" }>["presentation"],
): SessionMessage {
    return {
        commandId: null,
        firstEvent: previewSessionEvent(eventId, sessionId),
        presentation,
        role: "assistant",
    };
}

export function previewAssistantText(
    eventId: string,
    sessionId: string,
    text: string,
    messageId: string | null = eventId,
): SessionMessage {
    return previewAssistantMessage(eventId, sessionId, {
        content: { text: previewSessionText(text), type: "text" },
        kind: "message",
        messageId,
    });
}

function previewAssistantThought(
    eventId: string,
    sessionId: string,
    text: string,
    options: { readonly messageId?: string | null; readonly omitted?: boolean; readonly truncated?: boolean } = {},
): SessionMessage {
    const messageId = options.messageId ?? eventId;
    return previewAssistantMessage(eventId, sessionId, {
        content: {
            text: previewSessionText(text, options.truncated ?? false),
            type: "text",
        },
        kind: "thought",
        messageId,
        omitted: options.omitted ?? false,
    });
}

function previewAssistantTool(eventId: string, sessionId: string, entry: SessionToolPresentation): SessionMessage {
    return previewAssistantMessage(eventId, sessionId, { entry, kind: "tool" });
}

function previewToolEntry(
    id: string,
    title: string,
    input: string,
    output: string,
    content: readonly AgentDisplayContent[],
    state: SessionToolPresentation["state"] = { kind: "succeeded" },
): SessionToolPresentation {
    return {
        content,
        id,
        input,
        kind: "tool",
        name: title,
        output,
        state,
        title,
    };
}

/** Covers common SessionMessage and presentation shapes for the style preview. */
export function createMessageTypesShowcase(sessionId: string): readonly SessionMessage[] {
    return [
        previewUserText("showcase-user-text", sessionId, "Help me review spacing on message bubbles and tool rows."),
        previewAssistantText(
            "showcase-assistant-text",
            sessionId,
            "Use **Markdown** in assistant replies.\n\n- `MessageBubble` for user\n- `AgentResponseText` for agent\n\n```ts\nconst streaming = active;\n```",
            "showcase-assistant-msg",
        ),
        previewAssistantThought(
            "showcase-thought",
            sessionId,
            "Need to compare user bubble radii against composer padding before suggesting token changes.",
            { messageId: "showcase-thought-msg" },
        ),
        previewAssistantTool(
            "showcase-tool-read",
            sessionId,
            previewToolEntry(
                "tool-read-1",
                "Read packages/web/src/components/chat/message-bubble.tsx",
                JSON.stringify({ path: "packages/web/src/components/chat/message-bubble.tsx" }),
                JSON.stringify({ formatted_output: "export function MessageBubble({ speaker, children }) {\n  …\n}" }),
                [],
            ),
        ),
        previewAssistantTool(
            "showcase-tool-grep",
            sessionId,
            previewToolEntry(
                "tool-grep-1",
                "Search SessionMessage",
                JSON.stringify({ pattern: "SessionMessage", path: "packages/web/src/views/chat" }),
                JSON.stringify({ matches: 12 }),
                [],
                { kind: "running" },
            ),
        ),
        previewAssistantTool(
            "showcase-tool-shell",
            sessionId,
            previewToolEntry(
                "tool-shell-1",
                "Run pnpm typecheck",
                JSON.stringify({ command: "pnpm typecheck", workdir: "packages/web" }),
                JSON.stringify({ exitCode: 0, output: "Done in 4.2s" }),
                [],
            ),
        ),
        previewAssistantTool(
            "showcase-tool-diff",
            sessionId,
            previewToolEntry(
                "tool-edit-1",
                "Update message-bubble.tsx",
                JSON.stringify({ changes: ["packages/web/src/components/chat/message-bubble.tsx"] }),
                "",
                [
                    {
                        newText:
                            '+                    : "flex w-fit max-w-full flex-col gap-1.5 rounded-md bg-user-message-surface px-4 py-3"',
                        oldText:
                            '-                    : "w-fit max-w-full rounded-[20px] border border-black/[0.045] bg-white"',
                        path: "packages/web/src/components/chat/message-bubble.tsx",
                        type: "diff",
                    },
                ],
            ),
        ),
        previewUserMessage("showcase-user-image", sessionId, [
            {
                data: PREVIEW_TINY_PNG_BASE64,
                mimeType: "image/png",
                type: "image",
                uri: "",
            },
            { text: "Reference screenshot for bubble radius.", type: "text" },
        ]),
        previewAssistantMessage("showcase-assistant-image", sessionId, {
            content: {
                data: PREVIEW_TINY_PNG_BASE64,
                mimeType: "image/png",
                type: "image",
                uri: "",
            },
            kind: "message",
            messageId: "showcase-image-msg",
        }),
        previewAssistantMessage("showcase-failure", sessionId, {
            code: "binding_not_approved",
            kind: "failure",
            message: "The local agent is not approved for this bot.",
        }),
        previewAssistantMessage("showcase-cancelled", sessionId, {
            kind: "completed",
            stopReason: "cancelled",
        }),
    ];
}
