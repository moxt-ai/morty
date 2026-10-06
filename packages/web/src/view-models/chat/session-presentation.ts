import type { ActiveTurnSnapshot } from "@moxt-ai/mobius-protocol";
import {
    type AgentContentEvent,
    type AgentDisplayContent,
    MobiusAgentActivityEvent,
    type MobiusAgentActivityNarrationEvent,
    type MobiusAttemptSummary,
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

interface SessionMessageContent {
    readonly contentId: string;
    readonly content: AgentDisplayContent;
}

export interface SessionTimelineSegment {
    readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
    readonly messages: readonly SessionMessage[];
}

export function appendSessionTimelineSegment(
    current: SessionTimelineSegment | null,
    next: SessionTimelineSegment,
): SessionTimelineSegment {
    if (current === null) {
        return next;
    }
    return {
        activities: new Map([...current.activities, ...next.activities]),
        messages: [...current.messages, ...next.messages],
    };
}

function coveredCommandIds(history: Extract<OpenMobiusSession["result"]["history"], { readonly status: "available" }>) {
    const precise: string[] = [];
    for (const messageId of history.coveredMessageIds.toReversed()) {
        const suffix = messageId.endsWith(":user") ? ":user" : messageId.endsWith(":agent") ? ":agent" : null;
        if (suffix === null) {
            continue;
        }
        const commandId = messageId.slice(0, -suffix.length);
        if (!precise.includes(commandId)) {
            precise.push(commandId);
        }
    }
    return [...precise, ...history.coveredCommandIds.filter((commandId) => !precise.includes(commandId))];
}

function promptImageContents(images: readonly PromptImage[] | undefined): readonly SessionMessageContent[] {
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
    for (const commandId of coveredCommandIds(history)) {
        let assistantStartIndex = historyIndex;
        while (assistantStartIndex > 0 && messages[assistantStartIndex - 1]?.role === "assistant") {
            assistantStartIndex -= 1;
        }
        const userIndex = assistantStartIndex - 1;
        if (assistantStartIndex === historyIndex) {
            break;
        }
        for (let index = assistantStartIndex; index < historyIndex; index += 1) {
            commandIdsByMessageIndex.set(index, commandId);
        }
        if (messages[userIndex]?.role === "user") {
            commandIdsByMessageIndex.set(userIndex, commandId);
            historyIndex = userIndex;
        } else {
            historyIndex = assistantStartIndex;
        }
    }
    const redundantMessageIndexes = new Set<number>();
    for (const [userIndex, commandId] of commandIdsByMessageIndex) {
        if (messages[userIndex]?.role !== "user") {
            continue;
        }
        let precedingStartIndex = userIndex;
        while (
            precedingStartIndex > 0 &&
            messages[precedingStartIndex - 1]?.role === "assistant" &&
            !commandIdsByMessageIndex.has(precedingStartIndex - 1)
        ) {
            precedingStartIndex -= 1;
        }
        if (precedingStartIndex === userIndex) {
            continue;
        }
        let coveredEndIndex = userIndex + 1;
        while (
            coveredEndIndex < messages.length &&
            messages[coveredEndIndex]?.role === "assistant" &&
            commandIdsByMessageIndex.get(coveredEndIndex) === commandId
        ) {
            coveredEndIndex += 1;
        }
        const preceding = messages
            .slice(precedingStartIndex, userIndex)
            .filter((message) => message.role === "assistant");
        const covered = messages
            .slice(userIndex + 1, coveredEndIndex)
            .filter((message) => message.role === "assistant");
        const precedingText = preceding.map((message) => message.text).join("");
        const coveredText = covered.map((message) => message.text).join("");
        const precedingContent = preceding
            .flatMap((message) => message.content)
            .map((content) => JSON.stringify(content));
        const coveredContent = new Set(
            covered.flatMap((message) => message.content).map((content) => JSON.stringify(content)),
        );
        if (
            (precedingText.length > 0 || precedingContent.length > 0) &&
            coveredText.includes(precedingText) &&
            precedingContent.every((content) => coveredContent.has(content))
        ) {
            for (let index = precedingStartIndex; index < userIndex; index += 1) {
                redundantMessageIndexes.add(index);
            }
        }
    }
    const activities = new Map<string, RecordedAgentActivity>();
    const presentedMessages = messages.flatMap((message, index): readonly SessionMessage[] => {
        if (redundantMessageIndexes.has(index)) {
            return [];
        }
        const coveredCommandId = commandIdsByMessageIndex.get(index);
        const id =
            coveredCommandId === undefined
                ? `history-${index.toString()}`
                : message.role === "user"
                  ? `${coveredCommandId}:user`
                  : `${coveredCommandId}-reply-${index.toString()}`;
        if (message.role === "user") {
            return [{ id, role: "user", text: message.text, contents: promptImageContents(message.images) }];
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
        return [
            {
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
            },
        ];
    });
    return { activities, messages: presentedMessages };
}

function emptyAssistantMessage(
    commandId: string,
    id = `${commandId}:agent`,
): Extract<SessionMessage, { readonly role: "assistant" }> {
    return {
        activityIds: [],
        attempt: null,
        commandId,
        contents: [],
        id,
        role: "assistant",
        text: "",
    };
}

function nextAssistantMessage(segment: SessionTimelineSegment, commandId: string) {
    const count = segment.messages.filter(
        (message) => message.role === "assistant" && message.commandId === commandId,
    ).length;
    return emptyAssistantMessage(commandId, `${commandId}:agent-${count.toString()}`);
}

function latestAssistantMessageIndex(segment: SessionTimelineSegment, commandId: string): number {
    return segment.messages.findLastIndex((message) => message.role === "assistant" && message.commandId === commandId);
}

export function startLiveTurnSessionPresentation(commandId: string, prompt: string): SessionTimelineSegment {
    return {
        activities: new Map(),
        messages: [
            { contents: [], id: `${commandId}:user`, role: "user", text: prompt },
            emptyAssistantMessage(commandId),
        ],
    };
}

export function appendLiveTurnText(
    segment: SessionTimelineSegment | null,
    commandId: string,
    text: string,
): SessionTimelineSegment {
    const current = segment ?? { activities: new Map(), messages: [] };
    const messages = [...current.messages];
    const index = latestAssistantMessageIndex(current, commandId);
    const latest = messages[index];
    if (latest?.role !== "assistant" || latest.activityIds.length > 0 || latest.contents.length > 0) {
        messages.push({ ...nextAssistantMessage(current, commandId), text });
    } else {
        messages[index] = { ...latest, text: `${latest.text}${text}` };
    }
    return { activities: current.activities, messages };
}

export function recordLiveTurnActivity(
    segment: SessionTimelineSegment | null,
    activity: MobiusAgentActivityEvent,
): SessionTimelineSegment {
    const current = segment ?? { activities: new Map(), messages: [] };
    const key = agentActivityKey(activity);
    const activities = new Map(current.activities);
    activities.set(key, { activity });
    if (current.messages.some((message) => message.role === "assistant" && message.activityIds.includes(key))) {
        return { activities, messages: current.messages };
    }
    const messages = [...current.messages];
    const index = latestAssistantMessageIndex(current, activity.commandId);
    const latest = messages[index];
    if (latest?.role !== "assistant" || latest.text.length > 0 || latest.contents.length > 0) {
        messages.push({ ...nextAssistantMessage(current, activity.commandId), activityIds: [key] });
    } else {
        messages[index] = { ...latest, activityIds: [...latest.activityIds, key] };
    }
    return { activities, messages };
}

export function appendLiveTurnNarration(
    segment: SessionTimelineSegment | null,
    narration: MobiusAgentActivityNarrationEvent,
): SessionTimelineSegment {
    const current = segment ?? { activities: new Map(), messages: [] };
    const key = JSON.stringify([narration.sessionId, narration.commandId, narration.activityId]);
    const previous = current.activities.get(key)?.activity;
    const activity = new MobiusAgentActivityEvent({
        activityId: narration.activityId,
        activityType: narration.activityType,
        commandId: narration.commandId,
        content: previous?.content ?? [],
        detail: previous?.detail ?? { kind: "unrecorded" },
        input: previous?.input ?? "",
        kind: "agent.activity",
        locations: previous?.locations ?? [],
        name: previous?.name ?? "",
        output: `${previous?.output ?? ""}${narration.text}`,
        sequence: narration.sequence,
        sessionId: narration.sessionId,
        status: previous?.status ?? "running",
        title: previous?.title ?? "Thinking",
        toolKind: previous?.toolKind ?? "",
    });
    return recordLiveTurnActivity(current, activity);
}

export function recordLiveTurnContent(
    segment: SessionTimelineSegment | null,
    event: AgentContentEvent,
): SessionTimelineSegment {
    const current = segment ?? { activities: new Map(), messages: [] };
    const messages = [...current.messages];
    const existingIndex = messages.findIndex(
        (message) =>
            message.role === "assistant" && message.contents.some((content) => content.contentId === event.contentId),
    );
    const existing = messages[existingIndex];
    if (existing?.role === "assistant") {
        messages[existingIndex] = {
            ...existing,
            contents: [
                ...existing.contents.filter((content) => content.contentId !== event.contentId),
                { content: event.content, contentId: event.contentId },
            ],
        };
        return { activities: current.activities, messages };
    }
    const latestIndex = latestAssistantMessageIndex(current, event.commandId);
    const latest = messages[latestIndex];
    const content = { content: event.content, contentId: event.contentId };
    if (latest?.role !== "assistant" || latest.text.length > 0 || latest.activityIds.length > 0) {
        messages.push({ ...nextAssistantMessage(current, event.commandId), contents: [content] });
    } else {
        messages[latestIndex] = { ...latest, contents: [...latest.contents, content] };
    }
    return { activities: current.activities, messages };
}

export function recordLiveTurnAttempt(
    segment: SessionTimelineSegment | null,
    commandId: string,
    attempt: MobiusAttemptSummary,
): SessionTimelineSegment {
    const current = segment ?? { activities: new Map(), messages: [] };
    const messages = [...current.messages];
    const index = latestAssistantMessageIndex(current, commandId);
    const latest = messages[index];
    if (latest?.role === "assistant") {
        messages[index] = { ...latest, attempt };
    } else {
        messages.push({ ...nextAssistantMessage(current, commandId), attempt });
    }
    return { activities: current.activities, messages };
}

export function recoverLiveTurnSessionPresentation(
    history: OpenMobiusSession["result"]["history"],
    turn: ActiveTurnSnapshot,
    sessionId: string,
): SessionTimelineSegment {
    const presented = historySessionPresentation(history, sessionId);
    const start = presented.messages.findIndex((message) => message.id === `${turn.commandId}:user`);
    // Continue appending to the recovered turn. A new empty segment would hide its history on the first delta.
    // History may contain more of a long turn than the bounded execution snapshot.
    return start < 0
        ? activeTurnSessionPresentation(turn, sessionId)
        : { activities: presented.activities, messages: presented.messages.slice(start) };
}

function activeTurnSessionPresentation(turn: ActiveTurnSnapshot, sessionId: string): SessionTimelineSegment {
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
    const activeMessages = active?.messages ?? [];
    const activeAssistantCommands = new Set(
        activeMessages.flatMap((message) =>
            message.role === "assistant" && message.commandId !== null ? [message.commandId] : [],
        ),
    );
    const activeUserIds = new Set(activeMessages.flatMap((message) => (message.role === "user" ? [message.id] : [])));
    const historyMessages = history.messages.filter((message) =>
        message.role === "user"
            ? !activeUserIds.has(message.id)
            : message.commandId === null || !activeAssistantCommands.has(message.commandId),
    );
    const messages = [...historyMessages, ...activeMessages];
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
