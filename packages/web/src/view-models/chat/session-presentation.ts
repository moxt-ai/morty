import {
    type AgentDisplayContent,
    decodeAgentContentEvent,
    MobiusAgentActivityEvent,
    MobiusControlEvent,
    type MobiusMessagePage,
    type MobiusSessionEvent,
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

interface SessionMessageContent {
    readonly contentId: string;
    readonly content: AgentDisplayContent;
}

interface RestoredSessionPresentation {
    readonly activeCommandId: string | null;
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly eventCursor: string;
    readonly lastSequence: bigint;
    readonly messages: readonly SessionMessage[];
}

const ACTIVE_ATTEMPT_KINDS: ReadonlySet<string> = new Set(["none", "dispatching", "running", "waiting_input"]);

function historyContents(
    images: readonly { readonly data: string; readonly mimeType: string; readonly name: string }[] | undefined,
): readonly SessionMessageContent[] {
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

export function historySessionMessages(history: OpenMobiusSession["result"]["history"]): readonly SessionMessage[] {
    return history.status === "available"
        ? history.messages.map((message, index): SessionMessage => {
              const id = `history-${index.toString()}`;
              return message.role === "user"
                  ? { id, role: "user", text: message.text, contents: historyContents(message.images) }
                  : {
                        activityIds: [],
                        id,
                        role: "assistant",
                        text: message.text,
                        attempt: null,
                        commandId: null,
                        contents: historyContents(message.images),
                    };
          })
        : [];
}

function restoredActivity(message: MobiusMessagePage["messages"][number], index: number) {
    const summary = message.activities[index];
    if (summary === undefined) {
        return null;
    }
    const activity = new MobiusAgentActivityEvent({
        activityId: summary.activityId,
        activityType: summary.activityType,
        commandId: message.commandId,
        content: [],
        detail: { kind: "unrecorded" },
        input: summary.input,
        kind: "agent.activity",
        locations: summary.locations,
        name: summary.name,
        output: summary.output,
        sequence: summary.sequence,
        sessionId: message.sessionId,
        status: summary.status,
        title: summary.title,
        toolKind: summary.toolKind,
    });
    return { activity, key: agentActivityKey(activity), sequence: BigInt(summary.sequence) };
}

export function restoreSessionPresentation(
    saved: MobiusMessagePage,
    history: OpenMobiusSession["result"]["history"],
): RestoredSessionPresentation {
    const activeCommandId =
        saved.messages.find((message) => ACTIVE_ATTEMPT_KINDS.has(message.attempt.kind))?.commandId ?? null;
    const activities = new Map<string, RecordedAgentActivity>();
    for (const message of saved.messages) {
        if (message.commandId === activeCommandId) {
            continue;
        }
        for (let index = 0; index < message.activities.length; index += 1) {
            const restored = restoredActivity(message, index);
            if (restored !== null) {
                activities.set(restored.key, { activity: restored.activity, sequence: restored.sequence });
            }
        }
    }
    const initial = historySessionMessages(history);
    const messages: readonly SessionMessage[] = [
        ...initial,
        ...[...saved.messages]
            .reverse()
            .filter(
                (message) => history.status !== "available" || !history.coveredCommandIds.includes(message.commandId),
            )
            .flatMap((message): readonly SessionMessage[] => {
                const activityIds = message.activities.flatMap((_, index) => {
                    const restored = restoredActivity(message, index);
                    return restored === null ? [] : [restored.key];
                });
                return [
                    { id: `${message.commandId}-user`, role: "user", text: message.prompt, contents: [] },
                    {
                        activityIds: message.commandId === activeCommandId ? [] : activityIds,
                        id: `${message.commandId}-reply`,
                        role: "assistant",
                        text: message.commandId === activeCommandId ? "" : message.response,
                        attempt: message.attempt,
                        commandId: message.commandId,
                        contents: message.contents.map((content, index) => ({
                            contentId: `saved-content-${index.toString()}`,
                            content,
                        })),
                    },
                ];
            }),
    ];
    return {
        activeCommandId,
        activities,
        eventCursor: activeCommandId === null ? saved.tailEventCursor : "",
        lastSequence: activeCommandId === null ? BigInt(saved.lastCommittedSequence) : 0n,
        messages,
    };
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
