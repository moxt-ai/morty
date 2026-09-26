import type { ActiveTurnSnapshot } from "@moxt-ai/mobius-protocol";
import type { RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import { historySessionPresentation, type SessionMessage } from "./session-presentation.ts";

/** The daemon owns the running turn; a browser replaces its display copy atomically. */
export function replaceTurnSnapshot(
    current: {
        readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
        readonly messages: readonly SessionMessage[];
    },
    sessionId: string,
    turn: ActiveTurnSnapshot,
): { readonly activities: ReadonlyMap<string, RecordedAgentActivity>; readonly messages: readonly SessionMessage[] } {
    const replacement = historySessionPresentation(
        {
            status: "available",
            coveredCommandIds: [],
            coveredMessageIds: [],
            truncated: false,
            messages: [
                { role: "user", text: turn.prompt },
                { role: "assistant", text: turn.text, activities: turn.activities, content: turn.content },
            ],
        },
        sessionId,
        turn.commandId,
    );
    const belongsToTurn = (message: SessionMessage): boolean =>
        message.role === "assistant"
            ? message.commandId === turn.commandId
            : message.id === turn.commandId || message.id === `${turn.commandId}-user`;
    const existing = current.messages.filter(belongsToTurn);
    const user = existing.find((message) => message.role === "user");
    const assistant = existing.find((message) => message.role === "assistant");
    const index = current.messages.findIndex(belongsToTurn);
    const before = index < 0 ? current.messages : current.messages.slice(0, index);
    const tail = index < 0 ? [] : current.messages.slice(index);
    const steeringIndex = tail.findLastIndex((message) => message.role === "user" && !belongsToTurn(message));
    // A steering prompt creates a display boundary inside a running turn. Keep
    // that boundary, but replace all text from the cumulative snapshot; never
    // append incoming text to an existing response.
    const anchored = steeringIndex < 0 ? [] : tail.slice(0, steeringIndex + 1);
    let textOffset = 0;
    const placedActivities = new Set<string>();
    const placedContent = new Set<string>();
    const latest = replacement.messages.find((message) => message.role === "assistant");
    const layout = anchored.map((message): SessionMessage => {
        if (message.role !== "assistant" || message.commandId !== turn.commandId || latest?.role !== "assistant") {
            return message;
        }
        const text = turn.text.slice(textOffset, textOffset + message.text.length);
        textOffset += text.length;
        const activityIds = message.activityIds.filter((key) => replacement.activities.has(key));
        for (const key of activityIds) {
            placedActivities.add(key);
        }
        const contents = latest.contents.filter((content) =>
            message.contents.some((previous) => previous.contentId === content.contentId),
        );
        for (const content of contents) {
            placedContent.add(content.contentId);
        }
        return { ...message, text, activityIds, contents };
    });
    const messages = replacement.messages.flatMap((message): readonly SessionMessage[] => {
        if (message.role === "user") {
            return anchored.length > 0 ? [] : [user ?? message];
        }
        return [
            {
                ...message,
                id: anchored.length > 0 ? `${message.id}-after-${tail[steeringIndex]?.id}` : message.id,
                text: turn.text.slice(textOffset),
                activityIds: message.activityIds.filter((key) => !placedActivities.has(key)),
                contents: message.contents.filter((content) => !placedContent.has(content.contentId)),
                attempt: assistant?.role === "assistant" ? assistant.attempt : null,
            },
        ];
    });
    const after = tail.slice(steeringIndex + 1).filter((message) => !belongsToTurn(message));
    return {
        activities: new Map([
            ...[...current.activities].filter(([, entry]) => entry.activity.commandId !== turn.commandId),
            ...replacement.activities,
        ]),
        messages: [...before, ...layout, ...messages, ...after],
    };
}
