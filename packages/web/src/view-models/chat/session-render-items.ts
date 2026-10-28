import type { AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import {
    type SessionExecutionMessage,
    type SessionExecutionState,
    type SessionMessage,
    sessionExecutions,
    sessionTextValue,
} from "./session-presentation.ts";

export type SessionRenderItem =
    | {
          readonly kind: "assistant-text";
          readonly id: string;
          readonly messageId: string | null;
          readonly text: string;
          readonly copyable: boolean;
      }
    | {
          readonly kind: "event";
          readonly message: SessionMessage;
      }
    | {
          readonly entries: readonly AgentThinkingEntry[];
          readonly id: string;
          readonly kind: "thinking";
      };

function assistantText(message: SessionMessage): { readonly messageId: string | null; readonly text: string } | null {
    if (
        message.role === "assistant" &&
        message.presentation.kind === "message" &&
        message.presentation.content.type === "text"
    ) {
        return { messageId: message.presentation.messageId, text: sessionTextValue(message.presentation.content.text) };
    }
    return null;
}

function thinkingEntry(message: SessionMessage): AgentThinkingEntry | null {
    if (message.role !== "assistant") {
        return null;
    }
    if (message.presentation.kind === "tool") {
        return message.presentation.entry;
    }
    if (message.presentation.kind === "thought" && message.presentation.content.type === "text") {
        return {
            id: message.firstEvent.eventId,
            kind: "reasoning",
            messageId: message.presentation.messageId,
            omitted: message.presentation.omitted,
            text: sessionTextValue(message.presentation.content.text),
            truncated: message.presentation.content.text.truncated,
        };
    }
    return null;
}

function executionRenderItems(
    messages: readonly SessionMessage[],
    state: SessionExecutionState,
): readonly SessionRenderItem[] {
    type RenderItemBuilder =
        | { kind: "assistant-text"; id: string; messageId: string | null; text: string[] }
        | { readonly kind: "event"; readonly message: SessionMessage }
        | { entries: AgentThinkingEntry[]; readonly id: string; readonly kind: "thinking" };
    const items: RenderItemBuilder[] = [];
    for (const message of messages) {
        const text = assistantText(message);
        const thinking = thinkingEntry(message);
        const previous = items.at(-1);
        if (text !== null && previous?.kind === "assistant-text" && previous.messageId === text.messageId) {
            previous.text.push(text.text);
        } else if (text !== null) {
            items.push({
                kind: "assistant-text",
                id: message.firstEvent.eventId,
                messageId: text.messageId,
                text: [text.text],
            });
        } else if (thinking !== null && previous?.kind === "thinking") {
            previous.entries.push(thinking);
        } else if (thinking !== null) {
            items.push({ entries: [thinking], id: message.firstEvent.eventId, kind: "thinking" });
        } else {
            items.push({ kind: "event", message });
        }
    }
    // Only the trailing response is an answer. A later tool/reasoning run or
    // steering message leaves earlier prose as progress, even after completion.
    const response = items.findLast((item) => item.kind !== "event" || item.message.role === "user");
    return items.map(
        (item): SessionRenderItem =>
            item.kind === "assistant-text"
                ? { ...item, text: item.text.join(""), copyable: state.kind !== "open" && item === response }
                : item,
    );
}

export function sessionRenderItems(
    messages: readonly SessionExecutionMessage[],
    sessionWorking: boolean,
): readonly SessionRenderItem[] {
    return sessionExecutions(messages, sessionWorking).flatMap((execution) =>
        executionRenderItems(execution.messages, execution.state),
    );
}

type SessionRenderGroup =
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "agent-reply";
      }
    | {
          readonly id: string;
          readonly item: SessionRenderItem;
          readonly kind: "user";
      };

export function sessionRenderItemId(item: SessionRenderItem): string {
    return item.kind === "event" ? item.message.firstEvent.eventId : item.id;
}

function isUserSessionRenderItem(item: SessionRenderItem): boolean {
    return item.kind === "event" && item.message.role === "user";
}

export function sessionRenderGroups(items: readonly SessionRenderItem[]): readonly SessionRenderGroup[] {
    const groups: SessionRenderGroup[] = [];
    let replyItems: SessionRenderItem[] = [];

    const flushReplyGroup = (): void => {
        if (replyItems.length === 0) {
            return;
        }
        const firstReplyItem = replyItems.at(0);
        if (firstReplyItem === undefined) {
            return;
        }
        groups.push({ id: sessionRenderItemId(firstReplyItem), items: replyItems, kind: "agent-reply" });
        replyItems = [];
    };

    for (const item of items) {
        if (isUserSessionRenderItem(item)) {
            flushReplyGroup();
            groups.push({ id: sessionRenderItemId(item), item, kind: "user" });
        } else {
            replyItems.push(item);
        }
    }
    flushReplyGroup();
    return groups;
}
