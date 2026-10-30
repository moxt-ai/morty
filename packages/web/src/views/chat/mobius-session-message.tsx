import type { ContentBlock } from "@moxt-ai/mobius-sdk/protocol";
import { CircleAlert, X } from "lucide-react";
import {
    AgentMarkdown,
    loadLatexRenderer,
    localFilePath,
    type MarkdownImageReader,
} from "../../components/agents/agent-markdown.tsx";
import { AgentResponseText } from "../../components/agents/agent-response-text.tsx";
import { isDisplayableImageType } from "../../components/agents/displayable-image-type.ts";
import { ExternalContentBlock, LinkedResourceBlock } from "../../components/agents/external-content-block.tsx";
import { loadDiagramRenderer } from "../../components/agents/mermaid-code-block.tsx";
import type { SessionResourceStoreFactory } from "../../components/agents/resource-reader.ts";
import { AgentThinking } from "../../components/chat/agent-thinking.tsx";
import { AttemptFailure } from "../../components/chat/attempt-failure.tsx";
import { AuthenticationNotice } from "../../components/chat/authentication-notice.tsx";
import { CompactionDisclosure } from "../../components/chat/compaction-disclosure.tsx";
import { MessageBubble } from "../../components/chat/message-bubble.tsx";
import { UserMessageShell } from "../../components/chat/user-message-shell.tsx";
import { ImageGallery, PreviewImage } from "../../components/images/image-gallery.tsx";
import { textLinkClassName } from "../../components/ui/text-link.ts";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { authenticationGuidance } from "../../view-models/chat/authentication-guidance.ts";
import {
    COMPACTION_CHARACTER_LIMIT,
    completedTurnNotice,
    type SessionMessage,
    sessionTextValue,
} from "../../view-models/chat/session-presentation.ts";
import { createSessionResourceStore } from "../../view-models/chat/session-resource-store.ts";

// Warm the lazily loaded rich renderers once the page settles, so the first
// LaTeX or Mermaid content resolves its renderer without a visible fallback
// swap. Deferred to idle because the chunks add ~244 kB gzip; agent replies
// arrive seconds later, well after idle has fired.
function warmRichRenderers(): void {
    void loadLatexRenderer();
    void loadDiagramRenderer();
}

if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => warmRichRenderers());
} else {
    setTimeout(warmRichRenderers, 2_000);
}

const SAFE_AUDIO_MIME = /^audio\/(?:aac|mpeg|mp4|ogg|wav|webm)$/u;

function safeRemoteUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

function MessageContentBlock({
    content,
    createResourceStore,
    openLocalFile,
    readImage,
    speaker,
}: {
    readonly content: ContentBlock;
    readonly createResourceStore: SessionResourceStoreFactory;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
    readonly speaker: "assistant" | "user";
}) {
    switch (content.type) {
        case "text": {
            const markdown = (
                <AgentMarkdown
                    createResourceStore={createResourceStore}
                    markdown={content.text}
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                    streaming={false}
                />
            );
            return speaker === "user" ? markdown : <MessageBubble speaker="assistant">{markdown}</MessageBubble>;
        }
        case "image":
            return isDisplayableImageType(content.mimeType) && content.data.length > 0 ? (
                speaker === "user" ? (
                    <PreviewImage
                        alt="Your attachment"
                        className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                        data-testid={dataTestId.userMessageImage}
                        src={`data:${content.mimeType};base64,${content.data}`}
                    />
                ) : (
                    <PreviewImage
                        alt="Agent-provided content"
                        className="max-h-[min(60vh,360px)] w-auto max-w-full rounded-xl border border-border object-contain"
                        src={`data:${content.mimeType};base64,${content.data}`}
                    />
                )
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
            const path = localFilePath(content.uri);
            if (path !== null) {
                return (
                    <LinkedResourceBlock
                        createResourceStore={createResourceStore}
                        mediaType={content.mimeType ?? "application/octet-stream"}
                        name={content.name}
                        path={path}
                        readContent={readImage}
                        speaker={speaker}
                    />
                );
            }
            const href = safeRemoteUrl(content.uri);
            return href === null ? (
                <p className="break-all text-sm text-muted-foreground">{content.title ?? content.name}</p>
            ) : (
                <a className={cn("break-all text-sm", textLinkClassName)} href={href} rel="noreferrer" target="_blank">
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
            return (
                <ExternalContentBlock
                    content={content}
                    createResourceStore={createResourceStore}
                    readContent={readImage}
                    speaker={speaker}
                />
            );
    }
}

function UserMessage({
    message,
    createResourceStore,
    deliveryUnknownUserMessageId,
    onRemoveUnknownDelivery,
    onRetryUnknownDelivery,
    openLocalFile,
    readImage,
}: {
    readonly message: Extract<SessionMessage, { readonly role: "user" }>;
    readonly createResourceStore: SessionResourceStoreFactory;
    readonly deliveryUnknownUserMessageId: string | null;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const deliveryUnknown = deliveryUnknownUserMessageId !== null && message.commandId === deliveryUnknownUserMessageId;
    const copyText = message.contents
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n\n");
    return (
        <div className="min-w-0 space-y-2">
            <ImageGallery>
                <UserMessageShell>
                    <MessageBubble
                        {...(copyText.length === 0 ? {} : { copyText })}
                        data-testid={dataTestId.userMessage}
                        speaker="user"
                    >
                        {message.contents.map((content, index) => (
                            <MessageContentBlock
                                content={content}
                                createResourceStore={createResourceStore}
                                key={`${message.firstEvent.eventId}:${index.toString()}`}
                                openLocalFile={openLocalFile}
                                readImage={readImage}
                                speaker="user"
                            />
                        ))}
                    </MessageBubble>
                </UserMessageShell>
            </ImageGallery>
            {deliveryUnknown && (
                <div
                    className="ml-auto flex max-w-[85%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive max-md:max-w-[94%]"
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
    createResourceStore,
    openLocalFile,
    readImage,
    streaming,
}: {
    readonly text: string;
    readonly createResourceStore?: SessionResourceStoreFactory | undefined;
    readonly streaming: boolean;
    readonly openLocalFile: (path: string) => void;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    return (
        <div className="min-w-0" data-testid={dataTestId.agentResponse}>
            <MessageBubble speaker="assistant">
                <AgentResponseText
                    text={text}
                    createResourceStore={createResourceStore}
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
    failureAgentRef = "",
    failureMachineName = "",
}: {
    readonly message: SessionMessage;
    readonly failureAgentRef?: string;
    readonly failureMachineName?: string;
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
    const createResourceStore: SessionResourceStoreFactory = createSessionResourceStore;
    if (message.role === "user") {
        return (
            <UserMessage
                createResourceStore={createResourceStore}
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
                    createResourceStore={createResourceStore}
                    openLocalFile={openLocalFile}
                    readImage={readImage}
                    text={sessionTextValue(presentation.content.text)}
                    streaming={active}
                />
            );
        }
        return (
            <div className="min-w-0" data-testid={dataTestId.agentResponse}>
                <MessageContentBlock
                    content={presentation.content}
                    createResourceStore={createResourceStore}
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
                    createResourceStore={createResourceStore}
                    entries={[
                        {
                            id: message.firstEvent.eventId,
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
            <MessageContentBlock
                content={presentation.content}
                createResourceStore={createResourceStore}
                openLocalFile={openLocalFile}
                readImage={readImage}
                speaker="assistant"
            />
        );
    }
    if (presentation.kind === "failure") {
        const guidance = authenticationGuidance(presentation.code, failureAgentRef, failureMachineName);
        if (guidance !== null) {
            return <AuthenticationNotice guidance={guidance} code={presentation.code} message={presentation.message} />;
        }
        return <AttemptFailure approval={failureApproval} code={presentation.code} message={presentation.message} />;
    }
    if (presentation.kind === "compaction") {
        return (
            <CompactionDisclosure
                error={presentation.error}
                status={presentation.status}
                summary={
                    presentation.summary === null
                        ? ""
                        : sessionTextValue(presentation.summary).slice(-COMPACTION_CHARACTER_LIMIT)
                }
            />
        );
    }
    if (presentation.kind === "completed") {
        const notice = completedTurnNotice(presentation.completion);
        if (notice === null) {
            return null;
        }
        return (
            <p className="text-sm text-muted-foreground" data-testid={dataTestId.agentReplyStatus} role="status">
                {notice}
            </p>
        );
    }
    return (
        <div data-testid={dataTestId.agentResponse}>
            <AgentThinking
                active={active}
                createResourceStore={createResourceStore}
                entries={[presentation.entry]}
                readImage={readImage}
            />
        </div>
    );
}
