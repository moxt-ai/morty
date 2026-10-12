import type { ContentBlockV2 } from "@moxt-ai/mobius-protocol";
import { externalContentPath, type MobiusExternalContentBlock } from "@moxt-ai/mobius-sdk";
import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentMarkdown, type MarkdownImageReader } from "../../components/agents/agent-markdown.tsx";
import { AgentResponseText } from "../../components/agents/agent-response-text.tsx";
import { AgentThinking } from "../../components/chat/agent-thinking.tsx";
import { AttemptFailure } from "../../components/chat/attempt-failure.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { dataTestId } from "../../data-testid.ts";
import { isDisplayableImageType } from "../../services/chat/image-media-type.ts";
import { type SessionMessage, sessionTextValue } from "../../view-models/chat/session-presentation.ts";

const SAFE_AUDIO_MIME = /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u;

function safeRemoteUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

type ExternalContentState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "ready"; readonly source: string; readonly text: string };

function ExternalContent({
    content,
    readContent,
    speaker,
}: {
    readonly content: MobiusExternalContentBlock;
    readonly readContent?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    const [state, setState] = useState<ExternalContentState>({ kind: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        let source = "";
        const load = async () => {
            if (readContent === undefined) {
                setState({ kind: "failed" });
                return;
            }
            try {
                const file = await readContent(externalContentPath(content), controller.signal);
                if (controller.signal.aborted) {
                    return;
                }
                if (content.type === "external_resource" && content.encoding === "text") {
                    setState({ kind: "ready", source: "", text: new TextDecoder().decode(file.bytes) });
                    return;
                }
                source = URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: file.mediaType }));
                setState({ kind: "ready", source, text: "" });
            } catch (error: unknown) {
                if (!controller.signal.aborted) {
                    console.error("External Session content could not be loaded", error);
                    setState({ kind: "failed" });
                }
            }
        };
        void load();
        return () => {
            controller.abort();
            if (source.length > 0) {
                URL.revokeObjectURL(source);
            }
        };
    }, [content, readContent]);

    if (state.kind === "loading") {
        return <p className="text-sm text-muted-foreground">Loading content…</p>;
    }
    if (state.kind === "failed") {
        return <p className="text-sm text-muted-foreground">Content could not be loaded.</p>;
    }
    switch (content.type) {
        case "external_image":
            return isDisplayableImageType(content.mimeType) && state.source.length > 0 ? (
                <img
                    alt="Agent-provided content"
                    className="max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                    data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                    src={state.source}
                />
            ) : (
                <p className="text-sm text-muted-foreground">Image content could not be displayed safely.</p>
            );
        case "external_audio":
            return SAFE_AUDIO_MIME.test(content.mimeType) && state.source.length > 0 ? (
                <audio controls src={state.source}>
                    <track kind="captions" />
                </audio>
            ) : (
                <p className="text-sm text-muted-foreground">Audio content could not be displayed safely.</p>
            );
        case "external_resource":
            return content.encoding === "text" ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                    {state.text}
                </pre>
            ) : (
                <a className="break-all text-sm underline" download href={state.source}>
                    Download resource
                </a>
            );
    }
}

function ContentBlock({
    content,
    openLocalFile,
    readImage,
    speaker,
}: {
    readonly content: ContentBlockV2;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    switch (content.type) {
        case "text":
            return (
                <MessageBubble
                    copyText={content.text}
                    speaker={speaker}
                    data-testid={speaker === "user" ? dataTestId.userMessage : undefined}
                >
                    <AgentMarkdown
                        className="[&_p]:my-0"
                        markdown={content.text}
                        openLocalFile={openLocalFile}
                        readImage={readImage}
                        streaming={false}
                    />
                </MessageBubble>
            );
        case "image":
            return isDisplayableImageType(content.mimeType) && content.data.length > 0 ? (
                <img
                    alt="Agent-provided content"
                    className="max-h-[480px] w-auto max-w-full rounded-xl border border-border object-contain"
                    data-testid={speaker === "user" ? dataTestId.userMessageImage : undefined}
                    src={`data:${content.mimeType};base64,${content.data}`}
                />
            ) : (
                <p className="text-sm text-muted-foreground">Image content could not be displayed safely.</p>
            );
        case "audio":
            return SAFE_AUDIO_MIME.test(content.mimeType) && content.data.length > 0 ? (
                <audio controls src={`data:${content.mimeType};base64,${content.data}`}>
                    <track kind="captions" />
                </audio>
            ) : (
                <p className="text-sm text-muted-foreground">Audio content could not be displayed safely.</p>
            );
        case "resource_link": {
            const href = safeRemoteUrl(content.uri);
            return href === null ? (
                <p className="break-all text-sm text-muted-foreground">{content.title ?? content.name}</p>
            ) : (
                <a className="break-all text-sm underline" href={href} rel="noreferrer" target="_blank">
                    {content.title ?? content.name}
                </a>
            );
        }
        case "resource":
            return "text" in content.resource ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                    {content.resource.text}
                </pre>
            ) : (
                <p className="break-all text-sm text-muted-foreground">Binary resource: {content.resource.uri}</p>
            );
        case "external_image":
        case "external_audio":
        case "external_resource":
            return <ExternalContent content={content} readContent={readImage} speaker={speaker} />;
    }
}

function UserMessage({
    message,
    deliveryUnknownUserMessageId,
    onRemoveUnknownDelivery,
    onRetryUnknownDelivery,
    openLocalFile,
    readImage,
}: {
    readonly message: Extract<SessionMessage, { readonly role: "user" }>;
    readonly deliveryUnknownUserMessageId: string | null;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const deliveryUnknown = deliveryUnknownUserMessageId !== null && message.commandId === deliveryUnknownUserMessageId;
    return (
        <div className="min-w-0 space-y-2">
            <div className="ml-auto grid max-w-[82%] gap-2">
                {message.contents.map((content, index) => (
                    <ContentBlock
                        content={content}
                        key={`${message.id}:${index.toString()}`}
                        openLocalFile={openLocalFile}
                        readImage={readImage}
                        speaker="user"
                    />
                ))}
            </div>
            {deliveryUnknown && (
                <div
                    className="ml-auto flex max-w-[82%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive"
                    role="alert"
                >
                    <button
                        aria-label="Retry message with unknown delivery"
                        className="inline-flex size-7 items-center justify-center rounded-full"
                        onClick={onRetryUnknownDelivery}
                        type="button"
                    >
                        <CircleAlert aria-hidden="true" className="size-4.5" />
                    </button>
                    <span className="min-w-0 flex-1">
                        Delivery wasn’t confirmed. This message won’t be sent again unless you retry it.
                    </span>
                    <button aria-label="Remove failed message" onClick={onRemoveUnknownDelivery} type="button">
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            )}
        </div>
    );
}

export function MobiusAssistantText({
    text,
    openLocalFile,
    readImage,
    streaming,
}: {
    readonly text: string;
    readonly streaming: boolean;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    return (
        <div className="min-w-0" data-testid={dataTestId.agentResponse}>
            <MessageBubble speaker="assistant">
                <AgentResponseText
                    text={text}
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                    streaming={streaming}
                />
            </MessageBubble>
        </div>
    );
}

export function MobiusSessionMessage({
    message,
    deliveryUnknownUserMessageId,
    onRemoveUnknownDelivery,
    onRetryUnknownDelivery,
    readImage,
    openLocalFile,
    active = false,
    failureApproval,
}: {
    readonly message: SessionMessage;
    readonly deliveryUnknownUserMessageId: string | null;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly openLocalFile: (path: string) => void;
    readonly active?: boolean;
    readonly failureApproval:
        | { readonly kind: "bot-approval"; readonly botId: string }
        | { readonly kind: "unavailable" };
}) {
    if (message.role === "user") {
        return (
            <UserMessage
                deliveryUnknownUserMessageId={deliveryUnknownUserMessageId}
                message={message}
                onRemoveUnknownDelivery={onRemoveUnknownDelivery}
                onRetryUnknownDelivery={onRetryUnknownDelivery}
                openLocalFile={openLocalFile}
                readImage={readImage}
            />
        );
    }
    const presentation = message.presentation;
    if (presentation.kind === "message") {
        if (presentation.content.type === "text") {
            return (
                <MobiusAssistantText
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                    text={sessionTextValue(presentation.content.text)}
                    streaming={active}
                />
            );
        }
        return (
            <div className="min-w-0" data-testid={dataTestId.agentResponse}>
                <ContentBlock
                    content={presentation.content}
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                    speaker="assistant"
                />
            </div>
        );
    }
    if (presentation.kind === "thought") {
        if (presentation.content.type === "text") {
            return (
                <AgentThinking
                    active={active}
                    entries={[
                        {
                            id: message.id,
                            kind: "reasoning",
                            messageId: presentation.messageId,
                            text: sessionTextValue(presentation.content.text),
                            truncated: presentation.content.text.truncated,
                        },
                    ]}
                />
            );
        }
        return (
            <ContentBlock
                content={presentation.content}
                openLocalFile={openLocalFile}
                readImage={readImage}
                speaker="assistant"
            />
        );
    }
    if (presentation.kind === "failure") {
        return <AttemptFailure approval={failureApproval} code={presentation.code} message={presentation.message} />;
    }
    if (presentation.kind === "completed") {
        if (presentation.stopReason === "end_turn" || presentation.stopReason === "steered") {
            return null;
        }
        return (
            <p className="px-4 text-sm text-muted-foreground" data-testid={dataTestId.agentReplyStatus} role="status">
                {presentation.stopReason === "cancelled"
                    ? "Response cancelled."
                    : `Response stopped: ${presentation.stopReason}`}
            </p>
        );
    }
    return (
        <div data-testid={dataTestId.agentResponse}>
            <AgentThinking active={active} entries={[presentation.entry]} readImage={readImage} />
        </div>
    );
}
