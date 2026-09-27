import type { ActiveTurnSnapshot } from "@moxt-ai/mobius-protocol";
import {
    type AgentDisplayContent,
    MobiusAgentActivityEvent,
    type MobiusMessagePage,
    type PromptImage,
} from "@moxt-ai/mobius-sdk";
import { agentActivityKey, type RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
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

export interface SessionTimelineSegment {
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly messages: readonly SessionMessage[];
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

export function historySessionPresentation(
    history: OpenMobiusSession["result"]["history"],
    sessionId: string,
): SessionTimelineSegment {
    if (history.status !== "available") {
        return { activities: new Map(), messages: [] };
    }
    const messages = history.messages;
    const commandIdsByMessageIndex = new Map<number, string>();
    let historyIndex = messages.length;
    for (const commandId of history.coveredCommandIds) {
        let assistantStartIndex = historyIndex;
        while (assistantStartIndex > 0 && messages[assistantStartIndex - 1]?.role === "assistant") {
            assistantStartIndex -= 1;
        }
        const userIndex = assistantStartIndex - 1;
        if (assistantStartIndex === historyIndex || messages[userIndex]?.role !== "user") {
            break;
        }
        commandIdsByMessageIndex.set(userIndex, commandId);
        for (let index = assistantStartIndex; index < historyIndex; index += 1) {
            commandIdsByMessageIndex.set(index, commandId);
        }
        historyIndex = userIndex;
    }
    const activities = new Map<string, RecordedAgentActivity>();
    const presentedMessages = messages.map((message, index): SessionMessage => {
        const coveredCommandId = commandIdsByMessageIndex.get(index);
        const id =
            coveredCommandId === undefined
                ? `history-${index.toString()}`
                : message.role === "user"
                  ? `${coveredCommandId}-user`
                  : `${coveredCommandId}-reply-${index.toString()}`;
        if (message.role === "user") {
            return { id, role: "user", text: message.text, contents: promptImageContents(message.images) };
        }
        const commandId = coveredCommandId ?? `native-message-${index.toString()}`;
        const activityIds = message.activities.map((activity) => {
            const presented = new MobiusAgentActivityEvent({
                ...activity,
                commandId,
                detail: { kind: "unrecorded" },
                kind: "agent.activity",
                sessionId,
            });
            const key = agentActivityKey(presented);
            activities.set(key, {
                activity: presented,
            });
            return key;
        });
        return {
            activityIds,
            id,
            role: "assistant",
            text: message.text,
            attempt: message.outcome === undefined ? null : { kind: message.outcome },
            commandId: coveredCommandId ?? null,
            contents: [
                ...promptImageContents(message.images),
                ...message.content.map((content, contentIndex) => ({
                    contentId: `native-message-${index.toString()}-content-${contentIndex.toString()}`,
                    content,
                })),
            ],
        };
    });
    return { activities, messages: presentedMessages };
}

export function activeTurnSessionPresentation(turn: ActiveTurnSnapshot, sessionId: string): SessionTimelineSegment {
    const activities = new Map<string, RecordedAgentActivity>();
    const messages = turn.messages.map((message): SessionMessage => {
        if (message.role === "user") {
            return {
                contents: promptImageContents(message.images),
                id: message.id,
                role: "user",
                text: message.text,
            };
        }
        const activityIds = message.activities.map((activity) => {
            const presented = new MobiusAgentActivityEvent({
                ...activity,
                commandId: turn.commandId,
                detail: { kind: "unrecorded" },
                kind: "agent.activity",
                sessionId,
            });
            const key = agentActivityKey(presented);
            activities.set(key, { activity: presented });
            return key;
        });
        return {
            activityIds,
            attempt: null,
            commandId: turn.commandId,
            contents: message.content.map((content, index) => ({
                content,
                contentId: `${message.id}-content-${index.toString()}`,
            })),
            id: message.id,
            role: "assistant",
            text: message.text,
        };
    });
    return { activities, messages };
}

export function deriveSessionTimeline(
    history: SessionTimelineSegment,
    active: SessionTimelineSegment | null,
    working: {
        readonly attempt: Extract<SessionMessage, { readonly role: "assistant" }>["attempt"];
        readonly commandId: string;
    } | null,
): SessionTimelineSegment {
    const messages = [...history.messages, ...(active?.messages ?? [])];
    if (working !== null) {
        const assistantIndex = messages.findLastIndex(
            (message) => message.role === "assistant" && message.commandId === working.commandId,
        );
        const assistant = messages[assistantIndex];
        if (assistant?.role === "assistant") {
            messages[assistantIndex] = { ...assistant, attempt: working.attempt };
        }
    }
    return {
        activities: new Map([...history.activities, ...(active?.activities ?? [])]),
        messages,
    };
}
