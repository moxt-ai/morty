import type {
    AcpSessionUpdateV2,
    SessionEventV2,
    SessionHistoryMessageV3,
    SessionLiveEventItemV3,
    SessionLiveEventV3,
    SessionSettingsV3,
} from "@moxt-ai/mobius-protocol";
import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import {
    appendSessionMessageEvent,
    createSessionMessageReduction,
    prependSessionMessageEvents,
    type SessionMessage,
    type SessionMessageReduction,
    sessionReductionMessages,
} from "./session-presentation.ts";

export interface SessionEventHistory {
    readonly messages: readonly SessionHistoryMessageV3[];
    readonly nextCursor: string | null;
    readonly throughSeq: number;
}

interface PendingEvents {
    readonly buffer: readonly SessionLiveEventV3[];
    readonly reloadAttempted: boolean;
}

export type SessionProjection =
    | { readonly kind: "pristine"; readonly pending: PendingEvents | null; readonly revision: number }
    | {
          readonly kind: "established";
          readonly pagination: { readonly nextCursor: string | null };
          readonly pending: PendingEvents | null;
          readonly reduction: SessionMessageReduction;
          readonly revision: number;
          readonly throughSeq: number;
      };

export type SessionProjectionInput =
    | { readonly event: SessionLiveEventV3; readonly kind: "live-event" }
    | { readonly kind: "reconcile" }
    | { readonly history: SessionEventHistory; readonly kind: "history-loaded"; readonly revision: number }
    | { readonly kind: "older-page"; readonly page: SessionEventHistory; readonly revision: number };

export type SessionProjectionEffect =
    | { readonly kind: "load-history" }
    | {
          readonly config?: readonly SessionConfigOption[] | undefined;
          readonly kind: "adopted";
          readonly title?: string | undefined;
      };

export interface SessionProjectionResult {
    readonly effects: readonly SessionProjectionEffect[];
    readonly state: SessionProjection;
}

export function createSessionProjection(): SessionProjection {
    return { kind: "pristine", pending: null, revision: 0 };
}

function presentationEvent(sessionId: string, eventId: string, payload: AcpSessionUpdateV2): SessionEventV2 {
    return {
        eventId,
        payload,
        position: eventId,
        provenance: { kind: "original" },
        recordedAt: "1970-01-01T00:00:00.000Z",
        sessionGenerationId: "session-v3",
        sessionId,
        type: "acp",
    };
}

function historyPresentationEvents(message: SessionHistoryMessageV3): readonly SessionEventV2[] {
    const { item } = message;
    if (
        item.sessionUpdate === "user_message" ||
        item.sessionUpdate === "agent_message" ||
        item.sessionUpdate === "agent_thought"
    ) {
        return item.content.map((content, index) =>
            presentationEvent(message.sessionId, `v3-history:${message.messageId}:${index.toString()}`, {
                content,
                messageId: message.messageId,
                sessionUpdate:
                    item.sessionUpdate === "user_message"
                        ? "user_message_chunk"
                        : item.sessionUpdate === "agent_message"
                          ? "agent_message_chunk"
                          : "agent_thought_chunk",
            }),
        );
    }
    if (item.sessionUpdate === "tool_call") {
        return [
            presentationEvent(message.sessionId, `v3-history:${message.messageId}`, {
                ...item,
                sessionUpdate: "tool_call",
            }),
        ];
    }
    return [presentationEvent(message.sessionId, `v3-history:${message.messageId}`, item)];
}

function livePresentationEvent(event: SessionLiveEventV3): SessionEventV2 | null {
    const item: SessionLiveEventItemV3 = event.item;
    if (
        item.sessionUpdate !== "user_message_chunk" &&
        item.sessionUpdate !== "agent_message_chunk" &&
        item.sessionUpdate !== "agent_thought_chunk" &&
        item.sessionUpdate !== "tool_call" &&
        item.sessionUpdate !== "tool_call_update" &&
        item.sessionUpdate !== "plan"
    ) {
        return null;
    }
    return presentationEvent(event.sessionId, `v3-live:${event.seq.toString()}`, item);
}

function historyEvents(messages: readonly SessionHistoryMessageV3[]): readonly SessionEventV2[] {
    return messages.flatMap(historyPresentationEvents);
}

export function sessionSettingsOptions(settings: SessionSettingsV3): readonly SessionConfigOption[] {
    return settings.settings.map(
        (option): SessionConfigOption => ({
            booleanValue: typeof option.value === "boolean" ? option.value : false,
            category: "",
            currentValue: typeof option.value === "string" ? option.value : String(option.value),
            description: "",
            id: option.id,
            name: option.name,
            type: typeof option.value === "boolean" ? "boolean" : "select",
            values: [],
        }),
    );
}

function configOptions(item: SessionLiveEventItemV3): readonly SessionConfigOption[] | null {
    if (item.sessionUpdate !== "config_option_update") {
        return null;
    }
    return item.configOptions.map(
        (option): SessionConfigOption => ({
            booleanValue: typeof option.currentValue === "boolean" ? option.currentValue : false,
            category: "",
            currentValue: typeof option.currentValue === "string" ? option.currentValue : "",
            description: option.description ?? "",
            id: option.id,
            name: option.name,
            type: typeof option.currentValue === "boolean" ? "boolean" : "select",
            values:
                typeof option.currentValue === "boolean"
                    ? []
                    : (option.options ?? []).map((entry) => ({
                          description: entry.description ?? "",
                          groupId: "",
                          groupName: "",
                          name: entry.name,
                          value: entry.value,
                      })),
        }),
    );
}

function adoptionEffect(events: readonly SessionLiveEventV3[]): readonly SessionProjectionEffect[] {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) {
            continue;
        }
        const config = configOptions(event.item);
        if (config !== null) {
            return [{ config, kind: "adopted" }];
        }
    }
    return [];
}

function applyLive(
    state: Extract<SessionProjection, { readonly kind: "established" }>,
    events: readonly SessionLiveEventV3[],
): Extract<SessionProjection, { readonly kind: "established" }> {
    let reduction = state.reduction;
    let throughSeq = state.throughSeq;
    const ordered = events.toSorted((left, right) => left.seq - right.seq);
    for (const event of ordered) {
        if (event.seq <= throughSeq) {
            continue;
        }
        if (event.seq !== throughSeq + 1) {
            return {
                ...state,
                pending: { buffer: ordered.filter((candidate) => candidate.seq > throughSeq), reloadAttempted: false },
                reduction,
                throughSeq,
            };
        }
        const presentation = livePresentationEvent(event);
        if (presentation !== null) {
            reduction = appendSessionMessageEvent(reduction, presentation);
        }
        throughSeq = event.seq;
    }
    return { ...state, pending: null, reduction, throughSeq };
}

export function transitionSessionProjection(
    state: SessionProjection,
    input: SessionProjectionInput,
): SessionProjectionResult {
    switch (input.kind) {
        case "live-event": {
            if (state.kind === "pristine") {
                const revision = state.revision + 1;
                return {
                    effects: [{ kind: "load-history" }],
                    state: { ...state, pending: { buffer: [input.event], reloadAttempted: false }, revision },
                };
            }
            if (input.event.seq <= state.throughSeq) {
                return { effects: [], state };
            }
            if (state.pending !== null || input.event.seq !== state.throughSeq + 1) {
                const buffer = [...(state.pending?.buffer ?? []), input.event];
                if (state.pending !== null) {
                    return { effects: [], state: { ...state, pending: { ...state.pending, buffer } } };
                }
                const revision = state.revision + 1;
                return {
                    effects: [{ kind: "load-history" }],
                    state: { ...state, pending: { buffer, reloadAttempted: false }, revision },
                };
            }
            return {
                effects: adoptionEffect([input.event]),
                state: applyLive(state, [input.event]),
            };
        }
        case "reconcile": {
            const revision = state.revision + 1;
            return {
                effects: [{ kind: "load-history" }],
                state: { ...state, pending: { buffer: [], reloadAttempted: false }, revision },
            };
        }
        case "history-loaded": {
            if (state.pending === null || input.revision !== state.revision) {
                return { effects: [], state };
            }
            const buffered = state.pending.buffer.filter((event) => event.seq > input.history.throughSeq);
            const established: Extract<SessionProjection, { readonly kind: "established" }> = {
                kind: "established",
                pagination: { nextCursor: input.history.nextCursor },
                pending: null,
                reduction: createSessionMessageReduction({
                    events: historyEvents(input.history.messages),
                    nextCursor: input.history.nextCursor,
                }),
                revision: state.revision + 1,
                throughSeq: input.history.throughSeq,
            };
            const reconciled = applyLive(established, buffered);
            const applied = buffered.filter((event) => event.seq <= reconciled.throughSeq);
            const retry = reconciled.pending !== null && !state.pending.reloadAttempted;
            return {
                effects: [...adoptionEffect(applied), ...(retry ? [{ kind: "load-history" as const }] : [])],
                state:
                    retry && reconciled.pending !== null
                        ? { ...reconciled, pending: { ...reconciled.pending, reloadAttempted: true } }
                        : reconciled,
            };
        }
        case "older-page": {
            if (state.kind !== "established" || state.pending !== null || input.revision !== state.revision) {
                return { effects: [], state };
            }
            return {
                effects: [],
                state: {
                    ...state,
                    pagination: { nextCursor: input.page.nextCursor },
                    reduction: prependSessionMessageEvents(state.reduction, {
                        events: historyEvents(input.page.messages),
                        nextCursor: input.page.nextCursor,
                    }),
                    revision: state.revision + 1,
                },
            };
        }
        default:
            return input satisfies never;
    }
}

export function sessionProjectionMessages(state: SessionProjection): readonly SessionMessage[] {
    return state.kind === "established" ? sessionReductionMessages(state.reduction) : [];
}

export function sessionProjectionPagination(
    state: SessionProjection,
): { readonly nextCursor: string; readonly revision: number } | null {
    return state.kind === "established" && state.pending === null && state.pagination.nextCursor !== null
        ? { nextCursor: state.pagination.nextCursor, revision: state.revision }
        : null;
}
