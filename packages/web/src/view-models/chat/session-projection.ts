import type { SessionEvent, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionPresentationEvent } from "./session-presentation.ts";
import {
    appendSessionMessageEvent,
    createSessionMessageReduction,
    prependSessionMessageEvents,
    type SessionExecutionMessage,
    type SessionMessageReduction,
    sessionReductionExecutionOwner,
    sessionReductionMessages,
} from "./session-presentation.ts";

export interface SessionEventHistory {
    readonly throughPosition: string;
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
          readonly throughPosition: string;
          readonly pagination: { readonly nextCursor: string | null };
          readonly pending: PendingEvents | null;
          readonly reduction: SessionMessageReduction;
          readonly revision: number;
      };

export type SessionProjectionInput =
    | { readonly event: SessionLiveEvent; readonly kind: "live-event" }
    | { readonly kind: "reconcile" }
    | { readonly kind: "execution-idle" }
    | { readonly kind: "queue-observed"; readonly commandIds: readonly string[] }
    | { readonly kind: "execution-running"; readonly commandId: string }
    | { readonly history: SessionEventHistory; readonly kind: "history-loaded"; readonly revision: number }
    | { readonly kind: "older-page"; readonly page: SessionEventHistory; readonly revision: number };

export type SessionProjectionEffect =
    | { readonly generation: string | null; readonly kind: "load-history" }
    | {
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

function mergeSessionEvents(
    first: readonly SessionPresentationEvent[],
    second: readonly SessionPresentationEvent[],
): readonly SessionPresentationEvent[] {
    const events = new Map(first.map((event) => [event.eventId, event]));
    for (const event of second) {
        events.set(event.eventId, event);
    }
    return [...events.values()];
}

function newestTitle(events: readonly SessionPresentationEvent[]): string | undefined {
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

/** Live settings updates invalidate the display; only a Runtime read establishes current settings. */
function adoptionEffect(events: readonly SessionPresentationEvent[]): readonly SessionProjectionEffect[] {
    const title = newestTitle(events);
    const configurationChanged = events.some(
        (event) =>
            event.type === "acp" &&
            (event.payload.sessionUpdate === "config_option_update" ||
                event.payload.sessionUpdate === "current_mode_update"),
    );
    return [
        ...(title === undefined ? [] : [{ kind: "adopted" as const, title }]),
        ...(configurationChanged ? [{ kind: "read-settings" as const }] : []),
    ];
}

/** A new history baseline adopts its title, and leaves the current settings to the Runtime. */
function baselineEffects(events: readonly SessionPresentationEvent[]): readonly SessionProjectionEffect[] {
    const title = newestTitle(events);
    return [...(title === undefined ? [] : [{ kind: "adopted" as const, title }]), { kind: "read-settings" }];
}

function adoptGeneration(
    state: SessionProjection,
    history: SessionEventHistory,
    events: readonly SessionPresentationEvent[],
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

export function transitionSessionProjection(
    state: SessionProjection,
    input: SessionProjectionInput,
): SessionProjectionResult {
    switch (input.kind) {
        case "queue-observed": {
            if (state.kind !== "established") {
                return { effects: [], state };
            }
            const known = new Set(
                state.reduction.entries.flatMap((entry) => (entry.kind === "queued-command" ? [entry.commandId] : [])),
            );
            return {
                effects: [],
                state: {
                    ...state,
                    reduction: {
                        entries: [
                            ...state.reduction.entries,
                            ...input.commandIds
                                .filter((commandId) => !known.has(commandId))
                                .map((commandId) => ({ kind: "queued-command" as const, commandId })),
                        ],
                    },
                },
            };
        }
        case "execution-running":
            return {
                effects: [],
                state:
                    state.kind === "established"
                        ? {
                              ...state,
                              reduction: {
                                  entries: [
                                      ...state.reduction.entries,
                                      {
                                          kind: "execution-owner",
                                          commandId: input.commandId,
                                          executionCommandId: input.commandId,
                                          execution: "starts",
                                      },
                                      { kind: "turn-started", commandId: input.commandId },
                                  ],
                              },
                          }
                        : state,
            };
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
            if (BigInt(event.position) <= BigInt(state.throughPosition) || state.eventIds.has(event.eventId)) {
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
            const events = mergeSessionEvents(
                input.history.events,
                state.pending.buffer.filter(
                    (event) =>
                        event.sessionGenerationId === input.history.sessionGenerationId &&
                        BigInt(event.position) > BigInt(input.history.throughPosition),
                ),
            );
            return {
                effects: baselineEffects(events),
                state: adoptGeneration(state, input.history, events),
            };
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

export function sessionProjectionMessages(state: SessionProjection): readonly SessionExecutionMessage[] {
    return state.kind === "established" ? sessionReductionMessages(state.reduction) : [];
}

export function sessionProjectionPagination(
    state: SessionProjection,
): { readonly generation: string; readonly nextCursor: string; readonly revision: number } | null {
    return state.kind === "established" && state.pending === null && state.pagination.nextCursor !== null
        ? { generation: state.generation, nextCursor: state.pagination.nextCursor, revision: state.revision }
        : null;
}
