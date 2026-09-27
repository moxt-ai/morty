import type { ActiveTurnSnapshot } from "@moxt-ai/mobius-protocol";
import type { RecordedAgentActivity } from "../../services/chat/agent-activities.ts";
import { historySessionPresentation, type SessionMessage } from "./session-presentation.ts";

type AssistantSessionMessage = Extract<SessionMessage, { readonly role: "assistant" }>;

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
            messages: [{ role: "user", text: turn.prompt }, ...turn.messages],
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
    if (steeringIndex < 0) {
        const assistantAttempt = existing.findLast((message) => message.role === "assistant")?.attempt ?? null;
        const lastAssistantIndex = replacement.messages.findLastIndex((message) => message.role === "assistant");
        const replaced = replacement.messages.map((message, replacementIndex): SessionMessage => {
            if (message.role === "user") {
                return user ?? message;
            }
            const previous = existing.find(
                (candidate) => candidate.role === "assistant" && candidate.id === message.id,
            );
            return {
                ...message,
                attempt:
                    previous?.role === "assistant"
                        ? previous.attempt
                        : replacementIndex === lastAssistantIndex
                          ? assistantAttempt
                          : null,
            };
        });
        const displayed =
            lastAssistantIndex < 0 && assistant?.role === "assistant" ? [...replaced, assistant] : replaced;
        const after = tail.filter((message) => !belongsToTurn(message));
        return {
            activities: new Map([
                ...[...current.activities].filter(([, entry]) => entry.activity.commandId !== turn.commandId),
                ...replacement.activities,
            ]),
            messages: [...before, ...displayed, ...after],
        };
    }
    // A steering prompt creates a display boundary inside a running turn. Keep
    // that boundary while replacing each ordered snapshot segment atomically.
    const anchored = tail.slice(0, steeringIndex + 1);
    const replacementAssistants = replacement.messages.filter(
        (message): message is AssistantSessionMessage => message.role === "assistant",
    );
    const consumed = new Map<
        string,
        {
            readonly activityIds: ReadonlySet<string>;
            readonly contentIds: ReadonlySet<string>;
            readonly textLength: number;
        }
    >();
    const layout = anchored.map((message): SessionMessage => {
        if (message.role !== "assistant" || message.commandId !== turn.commandId) {
            return message;
        }
        const replacementMessage =
            replacementAssistants.find((candidate) => candidate.id === message.id) ??
            replacementAssistants.find((candidate) => !consumed.has(candidate.id));
        if (replacementMessage === undefined) {
            return message;
        }
        const textLength = Math.min(message.text.length, replacementMessage.text.length);
        const activityIds = message.activityIds.filter((key) => replacementMessage.activityIds.includes(key));
        const contents = replacementMessage.contents.filter((content) =>
            message.contents.some((previous) => previous.contentId === content.contentId),
        );
        consumed.set(replacementMessage.id, {
            activityIds: new Set(activityIds),
            contentIds: new Set(contents.map((content) => content.contentId)),
            textLength,
        });
        return {
            ...replacementMessage,
            activityIds,
            attempt: message.attempt,
            contents,
            id: message.id,
            text: replacementMessage.text.slice(0, textLength),
        };
    });
    const remaining = replacementAssistants.flatMap((message): readonly AssistantSessionMessage[] => {
        const prior = consumed.get(message.id);
        if (prior === undefined) {
            return [message];
        }
        const residual = {
            ...message,
            activityIds: message.activityIds.filter((key) => !prior.activityIds.has(key)),
            contents: message.contents.filter((content) => !prior.contentIds.has(content.contentId)),
            id: `${message.id}-after-${tail[steeringIndex]?.id}`,
            text: message.text.slice(prior.textLength),
        };
        return residual.text.length > 0 || residual.activityIds.length > 0 || residual.contents.length > 0
            ? [residual]
            : [];
    });
    const existingAfterSteering = tail
        .slice(steeringIndex + 1)
        .findLast((message) => message.role === "assistant" && message.commandId === turn.commandId);
    const messages =
        remaining.length > 0
            ? remaining.map((message, index) => ({
                  ...message,
                  attempt:
                      index === remaining.length - 1 && existingAfterSteering?.role === "assistant"
                          ? existingAfterSteering.attempt
                          : message.attempt,
              }))
            : existingAfterSteering?.role === "assistant"
              ? [existingAfterSteering]
              : [];
    const after = tail.slice(steeringIndex + 1).filter((message) => !belongsToTurn(message));
    return {
        activities: new Map([
            ...[...current.activities].filter(([, entry]) => entry.activity.commandId !== turn.commandId),
            ...replacement.activities,
        ]),
        messages: [...before, ...layout, ...messages, ...after],
    };
}
