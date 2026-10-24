import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import type { AcpSessionUpdate, SessionEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import {
    appendSessionMessageEvent,
    createSessionMessageReduction,
    prependSessionMessageEvents,
    type SessionMessage,
    type SessionMessageReduction,
    sessionReductionExecutionOwner,
    sessionReductionMessages,
} from "./session-presentation.ts";

export interface SessionEventHistory {
    readonly throughPosition: string | null;
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
}

interface PendingEvents {
    readonly generation: string | null;
    readonly buffer: readonly SessionLiveEvent[];
}

export type SessionProjection =
    | { readonly kind: "pristine"; readonly pending: PendingEvents | null; readonly revision: number }
    | {
          readonly kind: "established";
          readonly eventIds: ReadonlySet<string>;
          readonly generation: string;
          readonly firstEventId: string | null;
          readonly throughPosition: string | null;
          readonly pagination: { readonly nextCursor: string | null };
          readonly pending: PendingEvents | null;
          readonly reduction: SessionMessageReduction;
          readonly revision: number;
      };

export type SessionProjectionInput =
    | { readonly event: SessionLiveEvent; readonly kind: "live-event" }
    | { readonly kind: "reconcile" }
    | { readonly kind: "execution-idle" }
    | { readonly history: SessionEventHistory; readonly kind: "history-loaded"; readonly revision: number }
    | { readonly kind: "older-page"; readonly page: SessionEventHistory; readonly revision: number };

export type SessionProjectionEffect =
    | { readonly generation: string | null; readonly kind: "load-history" }
    | {
          readonly config?: readonly SessionConfigOption[] | undefined;
          readonly kind: "adopted";
          readonly title?: string | undefined;
      }
    /**
     * The history was loaded again: the page may have missed settings changes, and the history's settings events
     * cannot tell the current settings, because a change made from a settings menu writes none. The Runtime is asked
     * for its current settings.
     */
    | { readonly kind: "read-settings" };

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

function newestConfig(events: readonly SessionEvent[]): readonly SessionConfigOption[] | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "acp" && event.payload.sessionUpdate === "config_option_update") {
            return sessionConfigOptionsFromAcp(event.payload);
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

/** What events the page sees as they happen change: the settings and title they report become current. */
function adoptionEffect(events: readonly SessionEvent[]): readonly SessionProjectionEffect[] {
    const config = newestConfig(events);
    const title = newestTitle(events);
    if (config === null && title === undefined) {
        return [];
    }
    return [
        {
            // Only an explicit config update, including an empty one, can replace current settings.
            ...(config === null ? {} : { config }),
            kind: "adopted",
            ...(title === undefined ? {} : { title }),
        },
    ];
}

/** A new history baseline adopts its title, and leaves the current settings to the Runtime. */
function baselineEffects(events: readonly SessionEvent[]): readonly SessionProjectionEffect[] {
    const title = newestTitle(events);
    return [...(title === undefined ? [] : [{ kind: "adopted" as const, title }]), { kind: "read-settings" }];
}

/** Events a reload found after the ones the page saw apply as they would have live; the Runtime then confirms. */
function catchUpEffects(events: readonly SessionEvent[]): readonly SessionProjectionEffect[] {
    return [...adoptionEffect(events), { kind: "read-settings" }];
}

function adoptGeneration(
    state: SessionProjection,
    history: SessionEventHistory,
    events: readonly SessionEvent[],
): SessionProjection {
    return {
        eventIds: new Set(events.map((event) => event.eventId)),
        generation: history.sessionGenerationId,
        firstEventId: events.at(0)?.eventId ?? null,
        throughPosition: history.throughPosition,
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
        next = {
            ...next,
            eventIds: new Set([...next.eventIds, event.eventId]),
            firstEventId: next.firstEventId ?? event.eventId,
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
        case "execution-idle":
            // Native replay can retain unfinished tools without Mobius lifecycle metadata.
            // A confirmed idle snapshot settles only history already observed at this boundary.
            return {
                effects: [],
                state:
                    state.kind === "established"
                        ? { ...state, reduction: { entries: [...state.reduction.entries, { kind: "execution-idle" }] } }
                        : state,
            };
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
            if (state.pending !== null) {
                return {
                    effects: [],
                    state:
                        state.pending.generation !== null
                            ? state
                            : {
                                  ...state,
                                  pending: { ...state.pending, buffer: [...state.pending.buffer, event] },
                              },
                };
            }
            if (
                (state.throughPosition !== null && BigInt(event.position) <= BigInt(state.throughPosition)) ||
                state.eventIds.has(event.eventId)
            ) {
                return { effects: [], state };
            }
            return {
                effects: adoptionEffect([event]),
                state: {
                    ...state,
                    eventIds: new Set([...state.eventIds, event.eventId]),
                    firstEventId: state.firstEventId ?? event.eventId,
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
            const events = mergeSessionEvents(
                input.history.events,
                state.pending.buffer.filter(
                    (event) =>
                        event.sessionGenerationId === input.history.sessionGenerationId &&
                        (input.history.throughPosition === null ||
                            BigInt(event.position) > BigInt(input.history.throughPosition)),
                ),
            );
            // Older Runtimes have no coverage boundary, so retain their existing
            // append-only recovery until they are upgraded.
            if (replacing || input.history.throughPosition !== null) {
                return {
                    effects: baselineEffects(events),
                    state: adoptGeneration(state, input.history, events),
                };
            }
            const merged = applyNewerEvents(state, { ...input.history, events });
            return { effects: catchUpEffects(merged.events), state: merged.state };
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
                    firstEventId: input.page.events.at(0)?.eventId ?? state.firstEventId,
                    eventIds: new Set([...input.page.events.map((event) => event.eventId), ...state.eventIds]),
                    reduction: prependSessionMessageEvents(state.reduction, input.page),
                    revision: state.revision + 1,
                },
            };
        }
        default:
            return input satisfies never;
    }
}

export function sessionProjectionExecutionOwner(state: SessionProjection, commandId: string): string | null {
    return state.kind === "established" ? sessionReductionExecutionOwner(state.reduction, commandId) : null;
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
