import type { AcpSessionUpdateV2, ContentBlockV2, SessionEventV2 } from "@moxt-ai/mobius-protocol";
import type { AgentDisplayContent } from "@moxt-ai/mobius-sdk";
import { externalContentPath } from "@moxt-ai/mobius-sdk";

type ToolCallUpdateV2 = Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
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

type TextContentBlock = Extract<ContentBlockV2, { readonly type: "text" }>;
type SessionContentBlock =
    | (Omit<TextContentBlock, "text"> & { readonly text: SessionText })
    | Exclude<ContentBlockV2, TextContentBlock>;

export type SessionMessage =
    | {
          readonly role: "user";
          readonly firstEvent: SessionEventV2;
          readonly commandId: string | null;
          readonly contents: readonly ContentBlockV2[];
      }
    | {
          readonly role: "assistant";
          readonly firstEvent: SessionEventV2;
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

function sessionContent(content: ContentBlockV2, textLimit?: number): SessionContentBlock {
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

function displayContent(update: ToolCallUpdateV2): readonly AgentDisplayContent[] {
    return (update.content ?? []).map((item): AgentDisplayContent => {
        if (item.type === "diff") {
            return {
                artifactId: "",
                data: "",
                mimeType: "",
                name: item.path,
                newText: item.newText,
                oldText: item.oldText ?? "",
                path: item.path,
                terminalId: "",
                text: "",
                type: "diff",
                uri: "",
            };
        }
        if (item.type === "terminal") {
            return {
                artifactId: "",
                data: "",
                mimeType: "",
                name: "Terminal",
                newText: "",
                oldText: "",
                path: "",
                terminalId: item.terminalId,
                text: "",
                type: "terminal",
                uri: "",
            };
        }
        const content = item.content;
        switch (content.type) {
            case "text":
                return {
                    artifactId: "",
                    data: "",
                    mimeType: "text/plain",
                    name: "",
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: content.text,
                    type: "text",
                    uri: "",
                };
            case "image":
                return {
                    artifactId: "",
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "",
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "",
                    type: "image",
                    uri: content.uri ?? "",
                };
            case "audio":
                return {
                    artifactId: "",
                    data: content.data,
                    mimeType: content.mimeType,
                    name: "Audio",
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "",
                    type: "resource",
                    uri: "",
                };
            case "resource_link":
                return {
                    artifactId: "",
                    data: "",
                    mimeType: content.mimeType ?? "",
                    name: content.name,
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: content.description ?? "",
                    type: "resource_link",
                    uri: content.uri,
                };
            case "resource":
                return {
                    artifactId: "",
                    data: "blob" in content.resource ? content.resource.blob : "",
                    mimeType: content.resource.mimeType ?? "",
                    name: content.resource.uri,
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "text" in content.resource ? content.resource.text : "",
                    type: "resource",
                    uri: content.resource.uri,
                };
            case "external_image":
                return {
                    artifactId: "",
                    data: "",
                    mimeType: content.mimeType,
                    name: "Image",
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "",
                    type: "image",
                    uri: externalContentPath(content),
                };
            case "external_audio":
                return {
                    artifactId: "",
                    data: "",
                    mimeType: content.mimeType,
                    name: "Audio",
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            case "external_resource":
                return {
                    artifactId: "",
                    data: "",
                    mimeType: content.mimeType ?? "",
                    name: content.uri,
                    newText: "",
                    oldText: "",
                    path: "",
                    terminalId: "",
                    text: "",
                    type: "resource",
                    uri: externalContentPath(content),
                };
            default:
                return exhaustive(content);
        }
    });
}

function toolState(status: ToolCallUpdateV2["status"]): SessionToolCallState {
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
    update: ToolCallUpdateV2,
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

function isBotInstructions(content: ContentBlockV2): boolean {
    return content.type === "resource" && content.resource.uri === BOT_INSTRUCTIONS_URI;
}

function messageFromAcpUpdate(event: SessionEventV2, update: AcpSessionUpdateV2): SessionMessage | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk": {
            if (isBotInstructions(update.content)) {
                return null;
            }
            return {
                commandId: null,
                contents: [update.content],
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
        case "available_commands_update":
        case "compaction_summary_chunk":
        case "compaction_update":
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

export interface ReducedSessionMessage {
    readonly complete: boolean;
    readonly message: SessionMessage;
    readonly unresolvedEvents: readonly SessionEventV2[];
}

export interface SessionMessageReduction {
    readonly entries: readonly ReducedSessionMessage[];
}

function consumeSessionEvent(
    entries: readonly ReducedSessionMessage[],
    event: SessionEventV2,
    leadingEvent: "known" | "possibly-before-page",
): SessionEventResult {
    if (event.type === "lifecycle-metadata") {
        const lifecycle = event.payload;
        if (lifecycle.kind === "prompt.requested") {
            const contents = lifecycle.content.filter((content) => !isBotInstructions(content));
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
    event: SessionEventV2,
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
    events: readonly SessionEventV2[],
    leadingEvent: "known" | "possibly-before-page",
): SessionMessageReduction {
    let entries: readonly ReducedSessionMessage[] = [];
    for (const event of events) {
        entries = applySessionEvent(entries, event, consumeSessionEvent(entries, event, leadingEvent));
    }
    return { entries };
}

export function createSessionMessageReduction(history: {
    readonly events: readonly SessionEventV2[];
    readonly nextCursor: string | null;
}): SessionMessageReduction {
    return reduceSessionEvents(history.events, history.nextCursor === null ? "known" : "possibly-before-page");
}

function mergeSessionEventSequences(
    first: readonly SessionEventV2[],
    second: readonly SessionEventV2[],
): readonly SessionEventV2[] {
    const events = new Map(first.map((event) => [event.eventId, event]));
    for (const event of second) {
        events.set(event.eventId, event);
    }
    return [...events.values()].sort((left, right) =>
        left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0,
    );
}

export function appendSessionMessageEvent(
    reduction: SessionMessageReduction,
    event: SessionEventV2,
): SessionMessageReduction {
    return {
        entries: applySessionEvent(reduction.entries, event, consumeSessionEvent(reduction.entries, event, "known")),
    };
}

export function prependSessionMessageEvents(
    reduction: SessionMessageReduction,
    history: { readonly events: readonly SessionEventV2[]; readonly nextCursor: string | null },
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

export function sessionEventLogPresentation(events: readonly SessionEventV2[]): SessionTimeline {
    return { messages: sessionReductionMessages(reduceSessionEvents(events, "known")) };
}

export function sessionEventCommandIds(events: readonly SessionEventV2[]): readonly string[] {
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
