import { externalContentPath } from "@moxt-ai/mobius-sdk";
import type { AcpSessionUpdate, ContentBlock, SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { AgentDisplayContent } from "../../components/agents/display-content.ts";
import {
    REASONING_CHARACTER_LIMIT,
    type SessionToolCallState,
    type SessionToolPresentation,
} from "../../components/chat/tools/tool-contract.ts";

type ToolCallUpdate = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
const BOT_INSTRUCTIONS_URI = "morty://bot/instructions";

export const COMPACTION_CHARACTER_LIMIT = 16 * 1024;

export type SessionText =
    | {
          readonly kind: "initial";
          readonly length: number;
          readonly truncated: boolean;
          readonly value: string;
      }
    | {
          readonly kind: "appended";
          readonly length: number;
          readonly previous: SessionText;
          readonly truncated: boolean;
          readonly value: string;
      };

type TextContentBlock = Extract<ContentBlock, { readonly type: "text" }>;
type SessionContentBlock =
    | (Omit<TextContentBlock, "text"> & { readonly text: SessionText })
    | Exclude<ContentBlock, TextContentBlock>;

export type SessionMessage =
    | {
          readonly role: "user";
          readonly firstEvent: SessionEvent;
          readonly commandId: string | null;
          readonly contents: readonly ContentBlock[];
      }
    | {
          readonly role: "assistant";
          readonly firstEvent: SessionEvent;
          readonly commandId: string | null;
          readonly presentation:
              | { readonly kind: "message"; readonly content: SessionContentBlock; readonly messageId: string | null }
              | {
                    readonly kind: "thought";
                    readonly content: SessionContentBlock;
                    readonly messageId: string | null;
                    readonly omitted: boolean;
                }
              | { readonly kind: "tool"; readonly entry: SessionToolPresentation }
              | {
                    readonly kind: "compaction";
                    readonly compactionId: string;
                    readonly error: string | null;
                    readonly status: "in_progress" | "completed" | "failed" | "cancelled";
                    readonly summary: SessionText | null;
                }
              | { readonly kind: "completed"; readonly stopReason: string }
              | { readonly kind: "failure"; readonly code: string; readonly message: string };
      };

export interface SessionTimeline {
    readonly messages: readonly SessionMessage[];
}

function exhaustive(value: never): never {
    throw new Error(`Unsupported Session Event Log payload: ${JSON.stringify(value)}`);
}

function encodedJson(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
}

function initialSessionText(value: string, limit?: number): SessionText {
    const truncated = limit !== undefined && value.length > limit;
    const retained = truncated ? value.slice(-limit) : value;
    return { kind: "initial", length: retained.length, truncated, value: retained };
}

function sessionContent(content: ContentBlock, textLimit?: number): SessionContentBlock {
    return content.type === "text" ? { ...content, text: initialSessionText(content.text, textLimit) } : content;
}

export function sessionTextValue(text: SessionText): string {
    const chunks: string[] = [];
    let current: SessionText = text;
    for (;;) {
        chunks.push(current.value);
        if (current.kind === "initial") {
            break;
        }
        current = current.previous;
    }
    chunks.reverse();
    return chunks.join("");
}

function appendSessionText(previous: SessionText, incoming: SessionText, prefix: string, limit?: number): SessionText {
    const value = `${prefix}${sessionTextValue(incoming)}`;
    const length = previous.length + value.length;
    const truncated = previous.truncated || incoming.truncated;
    if (limit === undefined || length <= limit) {
        return { kind: "appended", length, previous, truncated, value };
    }
    const previousLength = Math.max(0, limit - value.length);
    const retainedPrevious = previousLength === 0 ? "" : sessionTextValue(previous).slice(-previousLength);
    const retained = `${retainedPrevious}${value.slice(-limit)}`;
    return { kind: "initial", length: retained.length, truncated: true, value: retained };
}

function displayContent(update: ToolCallUpdate): readonly AgentDisplayContent[] {
    return (update.content ?? []).map((item): AgentDisplayContent => {
        if (item.type === "diff") {
            return {
                newText: item.newText,
                oldText: item.oldText ?? "",
                path: item.path,
                type: "diff",
            };
        }
        if (item.type === "terminal") {
            return {
                terminalId: item.terminalId,
                type: "terminal",
            };
        }
        const content = item.content;
        switch (content.type) {
            case "text":
                return {
                    text: content.text,
                    type: "text",
                };
            case "image":
                return {
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "",
                    type: "image",
                    uri: content.uri ?? "",
                };
            case "audio":
                return {
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "Audio",
                    text: "",
                    type: "resource",
                    uri: "",
                };
            case "resource_link":
                return {
                    mimeType: content.mimeType ?? "",
                    name: content.name,
                    text: content.description ?? "",
                    type: "resource_link",
                    uri: content.uri,
                };
            case "resource":
                return {
                    data: "blob" in content.resource ? content.resource.blob : "",
                    mimeType: content.resource.mimeType ?? "",
                    name: content.resource.uri,
                    text: "text" in content.resource ? content.resource.text : "",
                    type: "resource",
                    uri: content.resource.uri,
                };
            case "external_image":
                return {
                    data: "",
                    mimeType: content.mimeType,
                    name: "Image",
                    type: "image",
                    uri: externalContentPath(content),
                };
            case "external_audio":
                return {
                    data: "",
                    mimeType: content.mimeType,
                    name: "Audio",
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            case "external_resource":
                return {
                    data: "",
                    mimeType: content.mimeType ?? "",
                    name: content.uri,
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            default:
                return exhaustive(content);
        }
    });
}

function toolState(status: ToolCallUpdate["status"]): SessionToolCallState {
    switch (status) {
        case "pending":
        case "in_progress":
            return { kind: "running" };
        case "completed":
            return { kind: "succeeded" };
        case "failed":
            return { kind: "failed" };
        case null:
        case undefined:
            return { kind: "unknown" };
        default:
            return exhaustive(status);
    }
}

function mergeToolPresentation(
    previous: SessionToolPresentation | null,
    update: ToolCallUpdate,
): SessionToolPresentation {
    return {
        content: update.content === undefined ? (previous?.content ?? []) : displayContent(update),
        id: update.toolCallId,
        input: update.rawInput === undefined ? (previous?.input ?? "") : encodedJson(update.rawInput),
        kind: "tool",
        name: update.name === undefined ? (previous?.name ?? "") : (update.name ?? ""),
        output: update.rawOutput === undefined ? (previous?.output ?? "") : encodedJson(update.rawOutput),
        state: update.status === undefined ? (previous?.state ?? { kind: "unknown" }) : toolState(update.status),
        title:
            update.title === undefined ? (previous?.title ?? update.toolCallId) : (update.title ?? update.toolCallId),
    };
}

function isBotInstructions(content: ContentBlock): boolean {
    return content.type === "resource" && content.resource.uri === BOT_INSTRUCTIONS_URI;
}

function userDisplayContent(content: ContentBlock): ContentBlock {
    if (content.type !== "text") {
        return content;
    }
    const context =
        /^\s*<in-app-browser-context\s+source="ambient-ui-state">[\s\S]*?<\/in-app-browser-context>\s*## My request:\s*\r?\n/u;
    return { ...content, text: content.text.replace(context, "") };
}

type CompactionPresentation = Extract<SessionMessage, { role: "assistant" }>["presentation"] & {
    readonly kind: "compaction";
};
type CompactionUpdateVariant = Extract<AcpSessionUpdate, { readonly sessionUpdate: "compaction_update" }>;
type CompactionChunkVariant = Extract<AcpSessionUpdate, { readonly sessionUpdate: "compaction_summary_chunk" }>;

/** Applies ACP compaction patch semantics: chunks append to the streamed summary;
 *  a terminal update patches status/error, and its `summary` (when concrete)
 *  replaces the streamed one. */
function mergeCompactionPresentation(
    previous: CompactionPresentation | null,
    update: CompactionUpdateVariant | CompactionChunkVariant,
): CompactionPresentation {
    if (update.sessionUpdate === "compaction_summary_chunk") {
        const text = update.content.type === "text" ? update.content.text : "";
        const summary =
            previous !== null && text.length > 0
                ? appendSessionText(
                      previous.summary ?? initialSessionText(""),
                      initialSessionText(text, COMPACTION_CHARACTER_LIMIT),
                      "",
                      COMPACTION_CHARACTER_LIMIT,
                  )
                : text.length > 0
                  ? initialSessionText(text, COMPACTION_CHARACTER_LIMIT)
                  : (previous?.summary ?? null);
        return {
            compactionId: update.compactionId,
            error: previous?.error ?? null,
            kind: "compaction",
            status: previous?.status ?? "in_progress",
            summary,
        };
    }
    const replacement =
        update.summary === undefined || update.summary === null
            ? (previous?.summary ?? null)
            : compactionSummary(update.summary);
    return {
        compactionId: update.compactionId,
        error: Object.hasOwn(update, "error") ? (update.error ?? null) : (previous?.error ?? null),
        kind: "compaction",
        status: compactionStatus(update.status, previous?.status ?? "in_progress"),
        summary: replacement,
    };
}

function compactionSummary(summary: readonly ContentBlock[]): SessionText | null {
    // A terminal summary may span several text blocks; they read as one summary,
    // so aggregate them in order before applying the retention limit.
    const text = summary
        .flatMap((block) => (block?.type === "text" && block.text.length > 0 ? [block.text] : []))
        .join("");
    return text.length > 0 ? initialSessionText(text, COMPACTION_CHARACTER_LIMIT) : null;
}

function compactionStatus(
    status: string,
    fallback: NonNullable<CompactionPresentation["status"]>,
): NonNullable<CompactionPresentation["status"]> {
    switch (status) {
        case "in_progress":
        case "completed":
        case "failed":
        case "cancelled":
            return status;
        default:
            return fallback;
    }
}

function messageFromAcpUpdate(event: SessionEvent, update: AcpSessionUpdate): SessionMessage | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk": {
            if (isBotInstructions(update.content)) {
                return null;
            }
            return {
                commandId: null,
                contents: [userDisplayContent(update.content)],
                firstEvent: event,
                role: "user",
            };
        }
        case "agent_message_chunk":
            return {
                commandId: null,
                firstEvent: event,
                presentation: {
                    content: sessionContent(update.content),
                    kind: "message",
                    messageId: update.messageId ?? null,
                },
                role: "assistant",
            };
        case "agent_thought_chunk":
            return {
                commandId: null,
                firstEvent: event,
                presentation: {
                    content: sessionContent(update.content, REASONING_CHARACTER_LIMIT),
                    kind: "thought",
                    messageId: update.messageId ?? null,
                    omitted: event.mobiusMetadata?.omitted === true,
                },
                role: "assistant",
            };
        case "tool_call":
        case "tool_call_update":
            return null;
        case "compaction_update":
        case "compaction_summary_chunk":
            return null;
        case "available_commands_update":
        case "config_option_update":
        case "current_mode_update":
        case "plan":
        case "plan_removed":
        case "plan_update":
        case "session_info_update":
        case "usage_update":
            return null;
        default:
            return exhaustive(update);
    }
}

type SessionEventResult =
    | { readonly kind: "consumed"; readonly index: number; readonly message: SessionMessage }
    | { readonly kind: "turn-started"; readonly commandId: string }
    | {
          readonly kind: "turn-requested";
          readonly commandId: string;
          readonly executionCommandId: string;
          readonly message: SessionMessage | null;
      }
    | {
          readonly kind: "constructed";
          readonly firstEvent: FirstEventProvenance;
          readonly message: SessionMessage;
      }
    | { readonly kind: "skipped" };

function mergeAdjacentText(previous: SessionMessage | undefined, incoming: SessionMessage): SessionMessage | null {
    if (
        previous?.role !== "assistant" ||
        incoming.role !== "assistant" ||
        previous.presentation.kind !== incoming.presentation.kind ||
        (incoming.presentation.kind !== "message" && incoming.presentation.kind !== "thought") ||
        (previous.presentation.kind !== "message" && previous.presentation.kind !== "thought") ||
        (incoming.presentation.kind === "message" &&
            previous.presentation.messageId !== incoming.presentation.messageId) ||
        previous.presentation.content.type !== "text" ||
        incoming.presentation.content.type !== "text"
    ) {
        return null;
    }
    return {
        ...previous,
        presentation: {
            ...incoming.presentation,
            ...(incoming.presentation.kind === "thought" && previous.presentation.kind === "thought"
                ? { omitted: previous.presentation.omitted || incoming.presentation.omitted }
                : {}),
            content: {
                ...incoming.presentation.content,
                text: appendSessionText(
                    previous.presentation.content.text,
                    incoming.presentation.content.text,
                    incoming.presentation.kind === "thought" &&
                        previous.presentation.messageId !== incoming.presentation.messageId
                        ? "\n\n"
                        : "",
                    incoming.presentation.kind === "thought" ? REASONING_CHARACTER_LIMIT : undefined,
                ),
            },
        },
    };
}

/** What the page knows about an entry's first event.
 *  - "known": the entity's first event is on this page (or merged in); the
 *    entry renders and retains no events.
 *  - "possibly-before-page": the entity may have begun on an unobserved older
 *    page and the entry cannot render without its start (a bare tool-call
 *    tail); events stay retained for the merge and it hides until then.
 *  - "possibly-before-page-visible": the entity may have begun on an older
 *    page, but any observed event renders it (an id-addressed compaction);
 *    events stay retained and it renders while the merge is outstanding. */
type FirstEventProvenance = "known" | "possibly-before-page" | "possibly-before-page-visible";

interface ReducedSessionMessage {
    readonly kind: "message";
    readonly message: SessionMessage;
    readonly provenance: FirstEventProvenance;
    readonly unresolvedEvents: readonly SessionEvent[];
}

type ReducedSessionEntry =
    | ReducedSessionMessage
    | { readonly kind: "turn-started"; readonly commandId: string }
    | { readonly kind: "execution-idle" }
    | { readonly kind: "execution-owner"; readonly commandId: string; readonly executionCommandId: string };

export interface SessionMessageReduction {
    readonly entries: readonly ReducedSessionEntry[];
}

function consumeSessionEvent(
    entries: readonly ReducedSessionEntry[],
    event: SessionEvent,
    leadingEvent: "known" | "possibly-before-page",
): SessionEventResult {
    if (event.type === "lifecycle-metadata") {
        const lifecycle = event.payload;
        if (lifecycle.kind === "prompt.started") {
            return { kind: "turn-started", commandId: lifecycle.commandId };
        }
        if (
            lifecycle.kind === "prompt.completed" ||
            lifecycle.kind === "prompt.failed" ||
            lifecycle.kind === "prompt.failed-before-start"
        ) {
            return {
                kind: "constructed",
                firstEvent: "known",
                message: {
                    role: "assistant",
                    commandId: lifecycle.commandId,
                    firstEvent: event,
                    presentation:
                        lifecycle.kind === "prompt.completed"
                            ? { kind: "completed", stopReason: lifecycle.stopReason }
                            : { kind: "failure", code: lifecycle.code, message: lifecycle.message },
                },
            };
        }
        if (lifecycle.kind === "prompt.requested") {
            const contents = lifecycle.content.filter((content) => !isBotInstructions(content)).map(userDisplayContent);
            return {
                kind: "turn-requested",
                commandId: lifecycle.commandId,
                executionCommandId:
                    lifecycle.disposition === "steer"
                        ? (lifecycle.targetCommandId ?? lifecycle.commandId)
                        : lifecycle.commandId,
                message:
                    contents.length === 0
                        ? null
                        : {
                              commandId: lifecycle.commandId,
                              contents,
                              firstEvent: event,
                              role: "user",
                          },
            };
        }
        return { kind: "skipped" };
    }
    const update = event.payload;
    if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
        const existingIndex = entries.findIndex(
            (entry) =>
                entry.kind === "message" &&
                entry.message.role === "assistant" &&
                entry.message.presentation.kind === "compaction" &&
                entry.message.presentation.compactionId === update.compactionId,
        );
        const existingEntry = entries[existingIndex];
        const existing = existingEntry?.kind === "message" ? existingEntry.message : undefined;
        const previous =
            existing?.role === "assistant" && existing.presentation.kind === "compaction"
                ? existing.presentation
                : null;
        const message: SessionMessage = {
            commandId: null,
            firstEvent: existing?.firstEvent ?? event,
            presentation: mergeCompactionPresentation(previous, update),
            role: "assistant",
        };
        return existingIndex === -1
            ? {
                  // The entry keeps its events for cross-page merging whenever its
                  // own start (a leading in_progress per the ACP contract) has not
                  // been observed on this page, but it renders immediately: any of
                  // its events establishes the id-addressed entity, so the current
                  // state (streaming or settled) is visible without waiting for the
                  // older page that holds the start.
                  firstEvent:
                      update.sessionUpdate === "compaction_update" && update.status === "in_progress"
                          ? "known"
                          : leadingEvent === "known"
                            ? "known"
                            : "possibly-before-page-visible",
                  kind: "constructed",
                  message,
              }
            : { index: existingIndex, kind: "consumed", message };
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        const message = messageFromAcpUpdate(event, update);
        if (message === null) {
            return { kind: "skipped" };
        }
        const previousIndex = entries.length - 1;
        const previous = entries[previousIndex];
        const merged = mergeAdjacentText(previous?.kind === "message" ? previous.message : undefined, message);
        return merged === null
            ? {
                  firstEvent: entries.length === 0 ? leadingEvent : "known",
                  kind: "constructed",
                  message,
              }
            : { index: previousIndex, kind: "consumed", message: merged };
    }
    const existingIndex = entries.findIndex(
        (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            entry.message.presentation.kind === "tool" &&
            entry.message.presentation.entry.id === update.toolCallId,
    );
    const existingEntry = entries[existingIndex];
    const existing = existingEntry?.kind === "message" ? existingEntry.message : undefined;
    const previous =
        existing?.role === "assistant" && existing.presentation.kind === "tool" ? existing.presentation.entry : null;
    const message: SessionMessage = {
        commandId: null,
        firstEvent: existing?.firstEvent ?? event,
        presentation: { entry: mergeToolPresentation(previous, update), kind: "tool" },
        role: "assistant",
    };
    return existingIndex === -1
        ? {
              firstEvent: update.sessionUpdate === "tool_call" ? "known" : "possibly-before-page",
              kind: "constructed",
              message,
          }
        : { index: existingIndex, kind: "consumed", message };
}

function applySessionEvent(
    entries: readonly ReducedSessionEntry[],
    event: SessionEvent,
    result: SessionEventResult,
): readonly ReducedSessionEntry[] {
    switch (result.kind) {
        case "turn-requested": {
            const withOwner: readonly ReducedSessionEntry[] = [
                ...entries,
                {
                    kind: "execution-owner",
                    commandId: result.commandId,
                    executionCommandId: result.executionCommandId,
                },
            ];
            return result.message === null
                ? withOwner
                : applySessionEvent(withOwner, event, {
                      kind: "constructed",
                      firstEvent: "known",
                      message: result.message,
                  });
        }
        case "turn-started":
            return [...entries, result];
        case "consumed": {
            const previous = entries[result.index];
            if (previous?.kind !== "message") {
                return entries;
            }
            const next = [...entries];
            next[result.index] = {
                kind: "message",
                message: result.message,
                provenance: previous.provenance,
                unresolvedEvents: previous.provenance === "known" ? [] : [...previous.unresolvedEvents, event],
            };
            return next;
        }
        case "constructed":
            return [
                ...entries,
                {
                    kind: "message",
                    message: result.message,
                    provenance: result.firstEvent,
                    unresolvedEvents: result.firstEvent === "known" ? [] : [event],
                },
            ];
        case "skipped":
            return entries;
        default:
            return exhaustive(result);
    }
}

function reduceSessionEvents(
    events: readonly SessionEvent[],
    leadingEvent: "known" | "possibly-before-page",
): SessionMessageReduction {
    let entries: readonly ReducedSessionEntry[] = [];
    for (const event of events) {
        entries = applySessionEvent(entries, event, consumeSessionEvent(entries, event, leadingEvent));
    }
    return { entries };
}

export function createSessionMessageReduction(history: {
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
}): SessionMessageReduction {
    return reduceSessionEvents(history.events, history.nextCursor === null ? "known" : "possibly-before-page");
}

function mergeSessionEventSequences(
    first: readonly SessionEvent[],
    second: readonly SessionEvent[],
): readonly SessionEvent[] {
    const events = new Map(first.map((event) => [event.eventId, event]));
    for (const event of second) {
        events.set(event.eventId, event);
    }
    return [...events.values()];
}

export function appendSessionMessageEvent(
    reduction: SessionMessageReduction,
    event: SessionEvent,
): SessionMessageReduction {
    return {
        entries: applySessionEvent(reduction.entries, event, consumeSessionEvent(reduction.entries, event, "known")),
    };
}

export function prependSessionMessageEvents(
    reduction: SessionMessageReduction,
    history: { readonly events: readonly SessionEvent[]; readonly nextCursor: string | null },
): SessionMessageReduction {
    const unresolvedEvents = reduction.entries.flatMap((entry) =>
        entry.kind === "message" ? entry.unresolvedEvents : [],
    );
    const older = createSessionMessageReduction({
        events: mergeSessionEventSequences(history.events, unresolvedEvents),
        nextCursor: history.nextCursor,
    });
    // Entries with retained events were replayed into the older reduction, where
    // their ids merge under one entity with the start events this page lacked;
    // they are superseded and dropped here. "known" entries have nothing to
    // merge and are kept as-is.
    return {
        entries: [
            ...older.entries,
            ...reduction.entries.filter((entry) => entry.kind !== "message" || entry.provenance === "known"),
        ],
    };
}

export function sessionReductionExecutionOwner(reduction: SessionMessageReduction, commandId: string): string | null {
    const owner = reduction.entries.find((entry) => entry.kind === "execution-owner" && entry.commandId === commandId);
    return owner?.kind === "execution-owner" ? owner.executionCommandId : null;
}

export function sessionReductionMessages(reduction: SessionMessageReduction): readonly SessionMessage[] {
    const messages: SessionMessage[] = [];
    const unfinished = new Map<string | null, number[]>();
    const executionOwners = new Map<string, string>();
    let turn: { readonly kind: "unknown" } | { readonly kind: "active" | "terminal"; readonly commandId: string } = {
        kind: "unknown",
    };
    const interrupt = (indexes: readonly number[]) => {
        for (const index of indexes) {
            const pending = messages[index];
            if (pending?.role === "assistant" && pending.presentation.kind === "tool") {
                messages[index] = {
                    ...pending,
                    presentation: {
                        ...pending.presentation,
                        entry: { ...pending.presentation.entry, state: { kind: "interrupted" } },
                    },
                };
            }
        }
    };
    for (const entry of reduction.entries) {
        if (entry.kind === "execution-owner") {
            executionOwners.set(entry.commandId, entry.executionCommandId);
            continue;
        }
        if (entry.kind === "execution-idle") {
            for (const indexes of unfinished.values()) {
                interrupt(indexes);
            }
            unfinished.clear();
            turn = { kind: "unknown" };
            continue;
        }
        if (entry.kind === "turn-started") {
            // A started event alone does not identify its execution: the request may be
            // on an older page and could describe steering of another command.
            const owner = executionOwners.get(entry.commandId);
            turn = owner === undefined ? { kind: "unknown" } : { kind: "active", commandId: owner };
            continue;
        }
        // A bare tool tail cannot render until the older page containing its start arrives.
        if (entry.provenance === "possibly-before-page") {
            continue;
        }
        let message = entry.message;
        if (message.role === "user" && message.firstEvent.type === "acp" && turn.kind === "terminal") {
            turn = { kind: "unknown" };
        }
        if (
            message.role === "assistant" &&
            message.presentation.kind === "tool" &&
            message.presentation.entry.state.kind === "running"
        ) {
            const commandId = message.commandId ?? (turn.kind === "unknown" ? null : turn.commandId);
            if (turn.kind === "terminal" && commandId === turn.commandId) {
                // An ACP notification already in flight can arrive after the turn fails.
                message = {
                    ...message,
                    presentation: {
                        ...message.presentation,
                        entry: { ...message.presentation.entry, state: { kind: "interrupted" } },
                    },
                };
            } else {
                const indexes = unfinished.get(commandId) ?? [];
                indexes.push(messages.length);
                unfinished.set(commandId, indexes);
            }
        }
        messages.push(message);
        const event = message.firstEvent;
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        const terminal = event.payload;
        if (
            terminal.kind !== "prompt.failed" &&
            (terminal.kind !== "prompt.completed" || terminal.stopReason === "steered")
        ) {
            continue;
        }
        // Unknown ownership occurs when a page starts midway through a turn. Its terminal
        // event settles those tools too; prepending history recalculates ownership in order.
        for (const owner of [terminal.commandId, null]) {
            interrupt(unfinished.get(owner) ?? []);
            unfinished.delete(owner);
        }
        if (turn.kind === "unknown" || turn.commandId === terminal.commandId) {
            turn = { kind: "terminal", commandId: terminal.commandId };
        }
    }
    return messages;
}

export function sessionEventLogPresentation(events: readonly SessionEvent[]): SessionTimeline {
    return { messages: sessionReductionMessages(reduceSessionEvents(events, "known")) };
}

export function sessionEventCommandIds(events: readonly SessionEvent[]): readonly string[] {
    const commandIds: string[] = [];
    for (const event of events) {
        if (event.type === "lifecycle-metadata") {
            if ("commandId" in event.payload && !commandIds.includes(event.payload.commandId)) {
                commandIds.push(event.payload.commandId);
            }
            continue;
        }
        const update = event.payload;
        if (
            update.sessionUpdate !== "user_message_chunk" ||
            update.messageId === null ||
            update.messageId === undefined ||
            commandIds.includes(update.messageId)
        ) {
            continue;
        }
        commandIds.push(update.messageId);
    }
    return commandIds;
}

export function completedTurnNotice(stopReason: string): string | null {
    switch (stopReason) {
        case "end_turn":
        case "steered":
            return null;
        case "cancelled":
            return "Turn stopped.";
        case "max_tokens":
            return "The response reached its length limit.";
        case "max_turn_requests":
            return "The agent reached its request limit for this turn.";
        case "refusal":
            return "The agent declined this request.";
        default:
            return "The response stopped before completing.";
    }
}
