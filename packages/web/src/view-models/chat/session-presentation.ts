import {
    type AgentDisplayContent,
    decodeAgentContentEvent,
    MobiusControlEvent,
    type MobiusMessagePage,
    type MobiusSessionEvent,
    type PromptImage,
} from "@moxt-ai/mobius-sdk";
import type { OpenMobiusSession } from "./open-session.ts";

export type SessionMessage =
    | {
          readonly role: "user";
          readonly id: string;
          readonly text: string;
          readonly contents: readonly SessionMessageContent[];
      }
    | {
          readonly role: "assistant";
          readonly activityIds: readonly string[];
          readonly id: string;
          readonly text: string;
          readonly commandId: string | null;
          readonly attempt: MobiusMessagePage["messages"][number]["attempt"] | null;
          readonly contents: readonly SessionMessageContent[];
      };

export interface SessionMessageContent {
    readonly contentId: string;
    readonly content: AgentDisplayContent;
}

export function promptImageContents(images: readonly PromptImage[] | undefined): readonly SessionMessageContent[] {
    return (images ?? []).map((image, index) => ({
        contentId: `history-image-${index.toString()}`,
        content: {
            artifactId: "",
            data: image.data,
            mimeType: image.mimeType,
            name: image.name,
            newText: "",
            oldText: "",
            path: "",
            terminalId: "",
            text: "",
            type: "image",
            uri: "",
        },
    }));
}

export function historySessionMessages(
    history: OpenMobiusSession["result"]["history"],
    activeCommandId: string | null = null,
): readonly SessionMessage[] {
    if (history.status !== "available") {
        return [];
    }
    const commandIdsByMessageIndex = new Map<number, string>();
    let historyIndex = history.messages.length;
    if (activeCommandId !== null && history.messages[historyIndex - 1]?.role === "user") {
        commandIdsByMessageIndex.set(historyIndex - 1, activeCommandId);
        historyIndex -= 1;
    }
    for (const commandId of history.coveredCommandIds) {
        let assistantStartIndex = historyIndex;
        while (assistantStartIndex > 0 && history.messages[assistantStartIndex - 1]?.role === "assistant") {
            assistantStartIndex -= 1;
        }
        const userIndex = assistantStartIndex - 1;
        if (assistantStartIndex === historyIndex || history.messages[userIndex]?.role !== "user") {
            break;
        }
        commandIdsByMessageIndex.set(userIndex, commandId);
        for (let index = assistantStartIndex; index < historyIndex; index += 1) {
            commandIdsByMessageIndex.set(index, commandId);
        }
        historyIndex = userIndex;
    }
    return history.messages.map((message, index): SessionMessage => {
        const coveredCommandId = commandIdsByMessageIndex.get(index);
        const id =
            coveredCommandId === undefined
                ? `history-${index.toString()}`
                : `${coveredCommandId}-${message.role === "user" ? "user" : "reply"}`;
        return message.role === "user"
            ? { id, role: "user", text: message.text, contents: promptImageContents(message.images) }
            : {
                  activityIds: [],
                  id,
                  role: "assistant",
                  text: message.text,
                  attempt: null,
                  commandId: coveredCommandId ?? null,
                  contents: promptImageContents(message.images),
              };
    });
}

export function placeAgentActivity(
    messages: readonly SessionMessage[],
    commandId: string,
    activityId: string,
): readonly SessionMessage[] {
    if (
        messages.some((message) => message.role === "assistant" && message.activityIds.some((id) => id === activityId))
    ) {
        return messages;
    }
    const lastIndex = messages.findLastIndex(
        (message) => message.role === "assistant" && message.commandId === commandId,
    );
    const last = messages[lastIndex];
    if (last === undefined || last.role !== "assistant") {
        return messages;
    }
    if (last.text.length === 0 && last.contents.length === 0) {
        return messages.map((message, index) =>
            index === lastIndex && message.role === "assistant"
                ? { ...message, activityIds: [...message.activityIds, activityId] }
                : message,
        );
    }
    return [
        ...messages.slice(0, lastIndex + 1),
        {
            activityIds: [activityId],
            attempt: last.attempt,
            commandId,
            contents: [],
            id: `${commandId}-reply-${activityId}`,
            role: "assistant",
            text: "",
        },
        ...messages.slice(lastIndex + 1),
    ];
}

function replaceMessageContent(
    messages: readonly SessionMessage[],
    commandId: string,
    contentId: string,
    content: AgentDisplayContent,
): readonly SessionMessage[] {
    const existing = messages.findIndex(
        (message) =>
            message.role === "assistant" &&
            message.commandId === commandId &&
            message.contents.some((candidate) => candidate.contentId === contentId),
    );
    const target =
        existing >= 0
            ? existing
            : messages.findLastIndex((message) => message.role === "assistant" && message.commandId === commandId);
    return messages.map((message, index) =>
        index === target && message.role === "assistant"
            ? {
                  ...message,
                  contents: [
                      ...message.contents.filter((candidate) => candidate.contentId !== contentId),
                      { contentId, content },
                  ],
              }
            : message,
    );
}

export function applyRecordedContents(
    messages: readonly SessionMessage[],
    events: readonly MobiusSessionEvent[],
): readonly SessionMessage[] {
    return events.reduce((current, event) => {
        if (!(event.payload instanceof MobiusControlEvent) || event.payload.kind !== "agent.content") {
            return current;
        }
        const decoded = decodeAgentContentEvent(event.payload.encodedPayload);
        return replaceMessageContent(current, decoded.commandId, decoded.contentId, decoded.content);
    }, messages);
}
