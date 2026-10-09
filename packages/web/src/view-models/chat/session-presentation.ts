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

export type SessionMessage =
    | {
          readonly role: "user";
          readonly id: string;
          readonly commandId: string | null;
          readonly contents: readonly ContentBlockV2[];
      }
    | {
          readonly role: "assistant";
          readonly id: string;
          readonly commandId: string | null;
          readonly presentation:
              | { readonly kind: "message"; readonly content: ContentBlockV2; readonly messageId: string | null }
              | { readonly kind: "thought"; readonly content: ContentBlockV2; readonly messageId: string | null }
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
    if (value === undefined) {
        return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
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

function isSubmittedContentEcho(submitted: ContentBlockV2, echoed: ContentBlockV2): boolean {
    if (submitted.type === echoed.type) {
        return JSON.stringify(submitted) === JSON.stringify(echoed);
    }
    if (submitted.type === "image" && echoed.type === "external_image") {
        return submitted.mimeType === echoed.mimeType;
    }
    if (submitted.type === "audio" && echoed.type === "external_audio") {
        return submitted.mimeType === echoed.mimeType;
    }
    return submitted.type === "resource" && echoed.type === "external_resource"
        ? submitted.resource.uri === echoed.uri
        : false;
}

function projectAcpUpdate(
    event: SessionEventV2,
    update: AcpSessionUpdateV2,
    submittedPrompts: Map<string, ContentBlockV2[]>,
): readonly SessionMessage[] {
    switch (update.sessionUpdate) {
        case "user_message_chunk": {
            for (const contents of submittedPrompts.values()) {
                const echoIndex = contents.findIndex((content) => isSubmittedContentEcho(content, update.content));
                if (echoIndex !== -1) {
                    contents.splice(echoIndex, 1);
                    return [];
                }
            }
            if (isBotInstructions(update.content)) {
                return [];
            }
            return [
                {
                    commandId: null,
                    contents: [update.content],
                    id: event.eventId,
                    role: "user",
                },
            ];
        }
        case "agent_message_chunk":
            return [
                {
                    commandId: null,
                    id: event.eventId,
                    presentation: { content: update.content, kind: "message", messageId: update.messageId ?? null },
                    role: "assistant",
                },
            ];
        case "agent_thought_chunk":
            return [
                {
                    commandId: null,
                    id: event.eventId,
                    presentation: { content: update.content, kind: "thought", messageId: update.messageId ?? null },
                    role: "assistant",
                },
            ];
        case "tool_call":
        case "tool_call_update":
            return [];
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
            return [];
        default:
            return exhaustive(update);
    }
}

function mergeAdjacentText(previous: SessionMessage | undefined, incoming: SessionMessage): SessionMessage | null {
    if (
        previous?.role !== "assistant" ||
        incoming.role !== "assistant" ||
        previous.presentation.kind !== incoming.presentation.kind ||
        (incoming.presentation.kind !== "message" && incoming.presentation.kind !== "thought") ||
        (previous.presentation.kind !== "message" && previous.presentation.kind !== "thought") ||
        previous.presentation.messageId !== incoming.presentation.messageId ||
        previous.presentation.content.type !== "text" ||
        incoming.presentation.content.type !== "text"
    ) {
        return null;
    }
    return {
        ...previous,
        presentation: {
            ...incoming.presentation,
            content: {
                ...incoming.presentation.content,
                text: previous.presentation.content.text + incoming.presentation.content.text,
            },
        },
    };
}

export interface SessionTimelineProjection {
    readonly append: (event: SessionEventV2) => SessionTimeline;
    readonly current: () => SessionTimeline;
}

export function createSessionTimelineProjection(events: readonly SessionEventV2[]): SessionTimelineProjection {
    const messages: SessionMessage[] = [];
    const submittedPrompts = new Map<string, ContentBlockV2[]>();
    const toolIndexes = new Map<string, number>();
    let timeline: SessionTimeline = { messages: [] };
    const commit = (): SessionTimeline => {
        timeline = { messages: [...messages] };
        return timeline;
    };
    const append = (event: SessionEventV2, publish: boolean): SessionTimeline => {
        if (event.type === "lifecycle-metadata") {
            const lifecycle = event.payload;
            if (lifecycle.kind === "prompt.requested") {
                submittedPrompts.set(lifecycle.commandId, [...lifecycle.content]);
                const contents = lifecycle.content.filter((content) => !isBotInstructions(content));
                if (contents.length === 0) {
                    return timeline;
                }
                messages.push({
                    commandId: lifecycle.commandId,
                    contents,
                    id: event.eventId,
                    role: "user",
                });
                return publish ? commit() : timeline;
            }
            if (
                lifecycle.kind === "prompt.completed" ||
                lifecycle.kind === "prompt.failed" ||
                lifecycle.kind === "prompt.failed-before-start"
            ) {
                submittedPrompts.delete(lifecycle.commandId);
            }
            return timeline;
        }
        const update = event.payload;
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
            const projected = projectAcpUpdate(event, update, submittedPrompts);
            if (projected.length === 0) {
                return timeline;
            }
            for (const message of projected) {
                const previousIndex = messages.length - 1;
                const merged = mergeAdjacentText(messages[previousIndex], message);
                if (merged === null) {
                    messages.push(message);
                } else {
                    messages[previousIndex] = merged;
                }
            }
            return publish ? commit() : timeline;
        }
        const existingIndex = toolIndexes.get(update.toolCallId);
        const existing = existingIndex === undefined ? undefined : messages[existingIndex];
        const previous =
            existing?.role === "assistant" && existing.presentation.kind === "tool"
                ? existing.presentation.entry
                : null;
        const message: SessionMessage = {
            commandId: null,
            id: existing?.id ?? event.eventId,
            presentation: { entry: mergeToolPresentation(previous, update), kind: "tool" },
            role: "assistant",
        };
        if (existingIndex === undefined) {
            toolIndexes.set(update.toolCallId, messages.length);
            messages.push(message);
        } else {
            messages[existingIndex] = message;
        }
        return publish ? commit() : timeline;
    };
    for (const event of events) {
        append(event, false);
    }
    commit();
    return {
        append: (event) => append(event, true),
        current: () => timeline,
    };
}

export function sessionEventLogPresentation(events: readonly SessionEventV2[]): SessionTimeline {
    return createSessionTimelineProjection(events).current();
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
