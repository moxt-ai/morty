import { externalContentPath } from "@moxt-ai/mobius-sdk";
import type { AcpSessionUpdate, ContentBlock, SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { AgentDisplayContent } from "./display-content.ts";

type ToolCallUpdate = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
const BOT_INSTRUCTIONS_URI = "morty://bot/instructions";

type SessionToolCallState =
    | { readonly kind: "running" }
    | { readonly kind: "succeeded" }
    | { readonly kind: "failed" }
    | { readonly kind: "interrupted" }
    | { readonly kind: "unknown" };

export interface SessionToolPresentation {
    readonly content: readonly AgentDisplayContent[];
    readonly id: string;
    readonly input: string;
    readonly kind: "tool";
    readonly name: string;
    readonly output: string;
    readonly state: SessionToolCallState;
    readonly title: string;
}

export const REASONING_CHARACTER_LIMIT = 16 * 1024;
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
    throw new Error(`Unsupported Session Event Log V2 payload: ${JSON.stringify(value)}`);
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
    | {
          readonly kind: "constructed";
          readonly firstEvent: "known" | "possibly-before-page";
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

interface ReducedSessionMessage {
    readonly complete: boolean;
    readonly message: SessionMessage;
    readonly unresolvedEvents: readonly SessionEvent[];
}

export interface SessionMessageReduction {
    readonly entries: readonly ReducedSessionMessage[];
}

function consumeSessionEvent(
    entries: readonly ReducedSessionMessage[],
    event: SessionEvent,
    leadingEvent: "known" | "possibly-before-page",
): SessionEventResult {
    if (event.type === "lifecycle-metadata") {
        const lifecycle = event.payload;
        if (lifecycle.kind === "prompt.requested") {
            const contents = lifecycle.content.filter((content) => !isBotInstructions(content)).map(userDisplayContent);
            return contents.length === 0
                ? { kind: "skipped" }
                : {
                      firstEvent: "known",
                      kind: "constructed",
                      message: {
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
                entry.message.role === "assistant" &&
                entry.message.presentation.kind === "compaction" &&
                entry.message.presentation.compactionId === update.compactionId,
        );
        const existing = existingIndex === -1 ? undefined : entries[existingIndex]?.message;
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
                  // Completeness is decided by the compaction's own first event, not
                  // by position: a leading in_progress is the entity's start (chunks
                  // and terminal updates may only follow it per the ACP contract), so
                  // the entry is complete. Any other first-observed event means the
                  // start may live on an older page, and the entry stays unresolved so
                  // prependSessionMessageEvents can merge that page under this id.
                  firstEvent:
                      update.sessionUpdate === "compaction_update" && update.status === "in_progress"
                          ? "known"
                          : "possibly-before-page",
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
        const merged = mergeAdjacentText(entries[previousIndex]?.message, message);
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
            entry.message.role === "assistant" &&
            entry.message.presentation.kind === "tool" &&
            entry.message.presentation.entry.id === update.toolCallId,
    );
    const existing = existingIndex === -1 ? undefined : entries[existingIndex]?.message;
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
    entries: readonly ReducedSessionMessage[],
    event: SessionEvent,
    result: SessionEventResult,
): readonly ReducedSessionMessage[] {
    switch (result.kind) {
        case "consumed": {
            const previous = entries[result.index];
            if (previous === undefined) {
                return entries;
            }
            const next = [...entries];
            next[result.index] = {
                complete: previous.complete,
                message: result.message,
                unresolvedEvents: previous.complete ? [] : [...previous.unresolvedEvents, event],
            };
            return next;
        }
        case "constructed":
            return [
                ...entries,
                {
                    complete: result.firstEvent === "known",
                    message: result.message,
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
    let entries: readonly ReducedSessionMessage[] = [];
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
    const unresolvedEvents = reduction.entries.flatMap((entry) => entry.unresolvedEvents);
    const older = createSessionMessageReduction({
        events: mergeSessionEventSequences(history.events, unresolvedEvents),
        nextCursor: history.nextCursor,
    });
    return {
        entries: [...older.entries, ...reduction.entries.filter((entry) => entry.complete)],
    };
}

export function sessionReductionMessages(reduction: SessionMessageReduction): readonly SessionMessage[] {
    return reduction.entries.flatMap((entry) => (entry.complete ? [entry.message] : []));
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
