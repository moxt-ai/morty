import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import type { AcpSessionUpdate, SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import {
    appendSessionMessageEvent,
    createSessionMessageReduction,
    prependSessionMessageEvents,
    type SessionMessage,
    type SessionMessageReduction,
    sessionReductionMessages,
} from "./session-presentation.ts";

export interface SessionEventHistory {
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
}

interface PendingEvents {
    readonly generation: string | null;
    readonly buffer: readonly SessionEvent[];
}

interface ObservedConfig {
    readonly eventId: string;
    readonly options: readonly SessionConfigOption[];
}

export type SessionProjection =
    | { readonly kind: "pristine"; readonly pending: PendingEvents | null; readonly revision: number }
    | {
          readonly kind: "established";
          readonly config: ObservedConfig | null;
          readonly eventIds: ReadonlySet<string>;
          readonly generation: string;
          readonly pagination: { readonly nextCursor: string | null };
          readonly pending: PendingEvents | null;
          readonly reduction: SessionMessageReduction;
          readonly revision: number;
      };

export type SessionProjectionInput =
    | { readonly event: SessionEvent; readonly kind: "live-event" }
    | { readonly kind: "reconcile" }
    | { readonly history: SessionEventHistory; readonly kind: "history-loaded"; readonly revision: number }
    | { readonly kind: "older-page"; readonly page: SessionEventHistory; readonly revision: number };

export type SessionProjectionEffect =
    | { readonly generation: string | null; readonly kind: "load-history" }
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

function sessionConfigOptionsFromAcp(
    update: Extract<AcpSessionUpdate, { readonly sessionUpdate: "config_option_update" }>,
): readonly SessionConfigOption[] {
    return update.configOptions.map((option) => ({
        booleanValue: option.type === "boolean" ? option.currentValue : false,
        category: option.category ?? "",
        currentValue: option.type === "select" ? option.currentValue : "",
        description: option.description ?? "",
        id: option.id,
        name: option.name,
        type: option.type,
        values:
            option.type === "boolean"
                ? []
                : option.options.flatMap((item) =>
                      "group" in item
                          ? item.options.map((value) => ({
                                description: value.description ?? "",
                                groupId: item.group,
                                groupName: item.name,
                                name: value.name,
                                value: value.value,
                            }))
                          : [
                                {
                                    description: item.description ?? "",
                                    groupId: "",
                                    groupName: "",
                                    name: item.name,
                                    value: item.value,
                                },
                            ],
                  ),
    }));
}

function mergeSessionEvents(first: readonly SessionEvent[], second: readonly SessionEvent[]): readonly SessionEvent[] {
    const events = new Map(first.map((event) => [event.eventId, event]));
    for (const event of second) {
        events.set(event.eventId, event);
    }
    return [...events.values()];
}

function newestConfig(events: readonly SessionEvent[]): ObservedConfig | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "acp" && event.payload.sessionUpdate === "config_option_update") {
            return { eventId: event.eventId, options: sessionConfigOptionsFromAcp(event.payload) };
        }
    }
    return null;
}

function newestTitle(events: readonly SessionEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
            event?.type === "acp" &&
            event.payload.sessionUpdate === "session_info_update" &&
            Object.hasOwn(event.payload, "title") &&
            event.payload.title !== null &&
            event.payload.title !== undefined
        ) {
            return event.payload.title;
        }
    }
    return undefined;
}

function adoptionEffect(
    events: readonly SessionEvent[],
    clearMissingConfig: boolean,
): readonly SessionProjectionEffect[] {
    const config = newestConfig(events);
    const title = newestTitle(events);
    if (config === null && title === undefined && !clearMissingConfig) {
        return [];
    }
    return [
        {
            ...(config === null ? (clearMissingConfig ? { config: [] } : {}) : { config: config.options }),
            kind: "adopted",
            ...(title === undefined ? {} : { title }),
        },
    ];
}

function adoptGeneration(
    state: SessionProjection,
    history: SessionEventHistory,
    events: readonly SessionEvent[],
): SessionProjection {
    return {
        config: newestConfig(events),
        eventIds: new Set(events.map((event) => event.eventId)),
        generation: history.sessionGenerationId,
        kind: "established",
        pagination: { nextCursor: history.nextCursor },
        pending: null,
        reduction: createSessionMessageReduction({ events, nextCursor: history.nextCursor }),
        revision: state.revision + 1,
    };
}

function applyNewerEvents(
    state: Extract<SessionProjection, { readonly kind: "established" }>,
    history: SessionEventHistory,
): { readonly events: readonly SessionEvent[]; readonly state: SessionProjection } {
    let next = { ...state, pending: null };
    const applied: SessionEvent[] = [];
    for (const event of history.events) {
        if (next.eventIds.has(event.eventId)) {
            continue;
        }
        const config = newestConfig([event]) ?? next.config;
        next = {
            ...next,
            config,
            eventIds: new Set([...next.eventIds, event.eventId]),
            reduction: appendSessionMessageEvent(next.reduction, event),
        };
        applied.push(event);
    }
    return { events: applied, state: next };
}

export function transitionSessionProjection(
    state: SessionProjection,
    input: SessionProjectionInput,
): SessionProjectionResult {
    switch (input.kind) {
        case "live-event": {
            const { event } = input;
            if (state.kind === "pristine" || event.sessionGenerationId !== state.generation) {
                if (state.pending?.generation === event.sessionGenerationId) {
                    return {
                        effects: [],
                        state: { ...state, pending: { ...state.pending, buffer: [...state.pending.buffer, event] } },
                    };
                }
                const revision = state.revision + 1;
                return {
                    effects: [{ generation: event.sessionGenerationId, kind: "load-history" }],
                    state: {
                        ...state,
                        pending: { buffer: [event], generation: event.sessionGenerationId },
                        revision,
                    },
                };
            }
            if (state.eventIds.has(event.eventId)) {
                return { effects: [], state };
            }
            const config = newestConfig([event]) ?? state.config;
            return {
                effects: adoptionEffect([event], false),
                state: {
                    ...state,
                    config,
                    eventIds: new Set([...state.eventIds, event.eventId]),
                    reduction: appendSessionMessageEvent(state.reduction, event),
                },
            };
        }
        case "reconcile": {
            const revision = state.revision + 1;
            return {
                effects: [{ generation: null, kind: "load-history" }],
                state: { ...state, pending: { buffer: [], generation: null }, revision },
            };
        }
        case "history-loaded": {
            if (state.pending === null || input.revision !== state.revision) {
                return { effects: [], state };
            }
            const replacing =
                state.pending.generation !== null ||
                state.kind === "pristine" ||
                input.history.sessionGenerationId !== state.generation;
            const events = mergeSessionEvents(input.history.events, state.pending.buffer);
            if (replacing) {
                const clearMissingConfig =
                    state.kind === "established" && state.generation !== input.history.sessionGenerationId;
                return {
                    effects: adoptionEffect(events, clearMissingConfig),
                    state: adoptGeneration(state, input.history, events),
                };
            }
            const merged = applyNewerEvents(state, input.history);
            return { effects: adoptionEffect(merged.events, false), state: merged.state };
        }
        case "older-page": {
            if (
                state.kind !== "established" ||
                state.pending !== null ||
                input.revision !== state.revision ||
                input.page.sessionGenerationId !== state.generation
            ) {
                return { effects: [], state };
            }
            return {
                effects: [],
                state: {
                    ...state,
                    pagination: { nextCursor: input.page.nextCursor },
                    reduction: prependSessionMessageEvents(state.reduction, input.page),
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
): { readonly generation: string; readonly nextCursor: string; readonly revision: number } | null {
    return state.kind === "established" && state.pending === null && state.pagination.nextCursor !== null
        ? { generation: state.generation, nextCursor: state.pagination.nextCursor, revision: state.revision }
        : null;
}
