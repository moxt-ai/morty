import type { PromptImage, PromptResource, SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { Check, CircleAlert, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { AgentThinking, type AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import { ChatMessageQueue } from "../../components/chat/chat-message-queue.tsx";
import {
    chatSessionColumnClassName,
    chatSessionMessageColumnClassName,
    chatSessionMessageItemClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { FilePreview } from "../../components/chat/file-preview.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { WorkingIndicator } from "../../components/chat/working-indicator.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { LinkButton } from "../../components/ui/link-button.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { LoadMoreTrigger } from "../../components/utils/load-more-trigger.tsx";
import { cn } from "../../lib/utils.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { QueuedDraftMessage } from "../../view-models/chat/conversation-creation-machine.ts";
import type { OpenMobiusSession } from "../../view-models/chat/open-session.ts";
import type { SessionActivityState } from "../../view-models/chat/session-activity-machine.ts";
import type { UnconfirmedSubmission } from "../../view-models/chat/session-delivery-store.ts";
import { sessionInteractionPresentation } from "../../view-models/chat/session-interaction-store.ts";
import {
    createSessionPaneModel,
    type SessionConnection,
    sessionPanePresentation,
} from "../../view-models/chat/session-pane-store.ts";
import { type SessionMessage, sessionTextValue } from "../../view-models/chat/session-presentation.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { useMortyApplication } from "../application/application-context.tsx";
import { MobiusAssistantText, MobiusSessionMessage } from "./mobius-session-message.tsx";

type SessionRenderItem =
    | {
          readonly kind: "assistant-text";
          readonly id: string;
          readonly messageId: string | null;
          readonly text: string;
      }
    | {
          readonly kind: "event";
          readonly message: SessionMessage;
      }
    | {
          readonly entries: readonly AgentThinkingEntry[];
          readonly id: string;
          readonly kind: "thinking";
      };

function assistantText(message: SessionMessage): { readonly messageId: string | null; readonly text: string } | null {
    if (
        message.role === "assistant" &&
        message.presentation.kind === "message" &&
        message.presentation.content.type === "text"
    ) {
        return { messageId: message.presentation.messageId, text: sessionTextValue(message.presentation.content.text) };
    }
    return null;
}

function thinkingEntry(message: SessionMessage): AgentThinkingEntry | null {
    if (message.role !== "assistant") {
        return null;
    }
    if (message.presentation.kind === "tool") {
        return message.presentation.entry;
    }
    if (message.presentation.kind === "thought" && message.presentation.content.type === "text") {
        return {
            id: message.firstEvent.eventId,
            kind: "reasoning",
            messageId: message.presentation.messageId,
            omitted: message.presentation.omitted,
            text: sessionTextValue(message.presentation.content.text),
            truncated: message.presentation.content.text.truncated,
        };
    }
    return null;
}

export function sessionRenderItems(messages: readonly SessionMessage[]): readonly SessionRenderItem[] {
    type RenderItemBuilder =
        | { kind: "assistant-text"; id: string; messageId: string | null; text: string[] }
        | { readonly kind: "event"; readonly message: SessionMessage }
        | { entries: AgentThinkingEntry[]; readonly id: string; readonly kind: "thinking" };
    const items: RenderItemBuilder[] = [];
    for (const message of messages) {
        const text = assistantText(message);
        const thinking = thinkingEntry(message);
        const previous = items.at(-1);
        if (text !== null && previous?.kind === "assistant-text" && previous.messageId === text.messageId) {
            previous.text.push(text.text);
        } else if (text !== null) {
            items.push({
                kind: "assistant-text",
                id: message.firstEvent.eventId,
                messageId: text.messageId,
                text: [text.text],
            });
        } else if (thinking !== null && previous?.kind === "thinking") {
            previous.entries.push(thinking);
        } else if (thinking !== null) {
            items.push({ entries: [thinking], id: message.firstEvent.eventId, kind: "thinking" });
        } else {
            items.push({ kind: "event", message });
        }
    }
    return items.map(
        (item): SessionRenderItem => (item.kind === "assistant-text" ? { ...item, text: item.text.join("") } : item),
    );
}

export {
    chatSessionMessageColumnClassName as mobiusSessionMessageColumnClassName,
    chatSessionMessageItemClassName as mobiusSessionMessageItemClassName,
    chatSessionMessageScrollClassName as mobiusSessionMessageScrollClassName,
    chatSessionPaneSectionClassName as mobiusSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";

export function SessionMessageListSkeleton() {
    return (
        <div role="status" aria-label="Loading messages" className={chatSessionColumnClassName}>
            <span className="sr-only">Loading messages</span>
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-1/3 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                    <div className="h-4 w-5/6 rounded-full bg-muted" />
                    <div className="h-4 w-3/5 rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

function SessionTitleSkeleton({ centered = false }: { readonly centered?: boolean }) {
    return (
        <h2 className={cn("min-w-0 flex-1 text-sm font-semibold", centered && "w-full max-w-full")}>
            <div
                role="status"
                aria-label="Loading conversation title"
                className={cn("max-w-full", centered && "mx-auto flex justify-center")}
            >
                <span className="sr-only">Loading conversation title</span>
                <div
                    aria-hidden="true"
                    className="h-4 w-40 max-w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none"
                />
            </div>
        </h2>
    );
}

function MobileSessionTitlePortal({ children }: { readonly children: ReactNode }) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setSlot(document.getElementById(dataTestId.mobileSessionTitleSlot));
    }, []);
    if (slot === null) {
        return null;
    }
    return createPortal(
        <div className="pointer-events-auto flex min-w-0 w-full max-w-full justify-center overflow-hidden">
            {children}
        </div>,
        slot,
    );
}

function SessionConversationTitleBar({
    title,
    titleEdit,
    titleLoading,
    titleInput,
    centered,
    onOpenTitleEdit,
    onSetTitleDraft,
    onCancelTitleEdit,
    onConfirmTitleEdit,
}: {
    readonly title: string;
    readonly titleEdit:
        | { readonly kind: "closed" }
        | { readonly kind: "editing"; readonly draft: string }
        | { readonly kind: "saving"; readonly draft: string };
    readonly titleLoading: boolean;
    readonly titleInput: React.RefObject<HTMLInputElement | null>;
    readonly centered: boolean;
    readonly onOpenTitleEdit: () => void;
    readonly onSetTitleDraft: (draft: string) => void;
    readonly onCancelTitleEdit: () => void;
    readonly onConfirmTitleEdit: () => void;
}) {
    const displayTitle = title || "Untitled session";
    if (titleEdit.kind === "closed") {
        if (titleLoading) {
            return <SessionTitleSkeleton centered={centered} />;
        }
        return (
            <h2
                className={cn("min-w-0 truncate text-sm font-semibold", centered && "w-full max-w-full text-center")}
                title={displayTitle}
            >
                <button
                    type="button"
                    aria-label={displayTitle}
                    className={cn(
                        "max-w-full cursor-pointer truncate rounded-md outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/70",
                        centered ? "mx-auto text-center" : "text-left",
                    )}
                    title="Rename conversation"
                    onClick={onOpenTitleEdit}
                >
                    {displayTitle}
                </button>
            </h2>
        );
    }
    const saving = titleEdit.kind === "saving";
    return (
        <div className={cn("flex min-w-0 items-center gap-0.5", centered ? "w-full max-w-full" : "flex-1")}>
            <input
                aria-label="Conversation title"
                className={cn(
                    "min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-0 py-0 text-sm font-semibold shadow-none outline-none ring-0 focus:ring-0 focus-visible:ring-0",
                    centered && "text-center",
                )}
                disabled={saving}
                maxLength={500}
                ref={titleInput}
                value={titleEdit.draft}
                onChange={(event) => onSetTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onConfirmTitleEdit();
                    }
                    if (event.key === "Escape") {
                        onCancelTitleEdit();
                    }
                }}
            />
            <Button
                aria-label="Cancel rename"
                disabled={saving}
                size="icon"
                variant="ghost"
                onClick={onCancelTitleEdit}
            >
                <X className="size-4" />
            </Button>
            <Button aria-label="Save title" disabled={saving} size="icon" variant="ghost" onClick={onConfirmTitleEdit}>
                <Check className="size-4" />
            </Button>
        </div>
    );
}

export function MobiusSessionPaneShell({
    title,
    titleLoading = false,
    mobileTitlePortaled = false,
    children,
    footer,
}: {
    readonly title?: string;
    readonly titleLoading?: boolean;
    readonly mobileTitlePortaled?: boolean;
    readonly children: ReactNode;
    readonly footer?: ReactNode;
}) {
    return (
        <section className={chatSessionPaneSectionClassName}>
            <header
                className={cn("h-12 shrink-0 items-center gap-1 px-6", mobileTitlePortaled ? "hidden sm:flex" : "flex")}
            >
                {titleLoading ? (
                    <SessionTitleSkeleton />
                ) : (
                    <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>
                        {title}
                    </h2>
                )}
            </header>
            {children}
            {footer}
        </section>
    );
}

export function MobiusSessionPaneLoading() {
    return (
        <>
            <MobiusSessionPaneShell mobileTitlePortaled titleLoading>
                <div aria-label="Messages" className={chatSessionMessageScrollClassName} role="log">
                    <SessionMessageListSkeleton />
                </div>
            </MobiusSessionPaneShell>
            <MobileSessionTitlePortal>
                <SessionTitleSkeleton centered />
            </MobileSessionTitlePortal>
        </>
    );
}

function DisconnectedNotice({
    onRetryNow,
    retry,
}: {
    readonly onRetryNow: () => void;
    readonly retry: { readonly kind: "scheduled"; readonly remainingSeconds: number } | { readonly kind: "exhausted" };
}) {
    return (
        <div data-testid={dataTestId.sessionReconnectNotice} className="mb-2 px-1 text-sm text-muted-foreground">
            {retry.kind === "scheduled" ? (
                <ScheduledRetryNotice onRetryNow={onRetryNow} remainingSeconds={retry.remainingSeconds} />
            ) : (
                <p role="status">
                    Automatic retries stopped. <LinkButton onClick={onRetryNow}>Retry now</LinkButton>
                </p>
            )}
        </div>
    );
}

function ScheduledRetryNotice({
    onRetryNow,
    remainingSeconds,
}: {
    readonly onRetryNow: () => void;
    readonly remainingSeconds: number;
}) {
    return (
        <p role="status">
            Retrying in {remainingSeconds} s <LinkButton onClick={onRetryNow}>Retry now</LinkButton>
        </p>
    );
}

/**
 * Shows a recovered submission whose delivery was never confirmed. The service
 * does not hold this message, so no projected user message carries the retry
 * and remove controls; the journal's own prompt stands in for it until the
 * service confirms the turn.
 */
function UnconfirmedDeliveryCard({
    delivery,
    onRemove,
    onRetry,
}: {
    readonly delivery: {
        readonly commandId: string;
        readonly displayPrompt: string;
        readonly images: readonly PromptImage[];
        readonly resources: readonly PromptResource[];
    };
    readonly onRemove: () => void;
    readonly onRetry: () => void;
}) {
    return (
        <div className={chatSessionMessageItemClassName} data-testid={dataTestId.unconfirmedDelivery}>
            <UserPromptMessage images={delivery.images} resources={delivery.resources} text={delivery.displayPrompt} />
            <div
                className="ml-auto flex max-w-[85%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive"
                role="alert"
            >
                <button
                    aria-label="Retry message with unknown delivery"
                    className="inline-flex size-7 items-center justify-center rounded-full"
                    onClick={onRetry}
                    type="button"
                >
                    <CircleAlert aria-hidden="true" className="size-4.5" />
                </button>
                <span className="min-w-0 flex-1">
                    Delivery wasn’t confirmed. This message won’t be sent again unless you retry it.
                </span>
                <button aria-label="Remove failed message" onClick={onRemove} type="button">
                    <X aria-hidden="true" className="size-4" />
                </button>
            </div>
        </div>
    );
}

function ReconnectingNotice() {
    return (
        <div data-testid={dataTestId.sessionReconnectNotice} className="mb-2 px-1 text-sm text-muted-foreground">
            <p role="status">Mobius is reconnecting…</p>
        </div>
    );
}

function SessionReconnectNotice({
    connection,
    onRetryNow,
}: {
    readonly connection: SessionConnection;
    readonly onRetryNow: () => void;
}) {
    if (connection.kind === "disconnected") {
        return <DisconnectedNotice onRetryNow={onRetryNow} retry={connection.retry} />;
    }
    return <ReconnectingNotice />;
}

/**
 * Stands in for older messages while an earlier history page is fetched above
 * the visible list. It carries no text of its own so the placeholder reads as
 * content rather than as a status label.
 */
function OlderHistorySkeleton() {
    return (
        <div aria-label="Loading older messages" className={`${chatSessionColumnClassName} mb-8`} role="status">
            <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
                <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                    <div className="h-4 w-2/3 rounded-full bg-muted" />
                    <div className="h-4 w-4/5 rounded-full bg-muted" />
                </div>
                <div className="grid w-full max-w-[78%] gap-2">
                    <div className="h-4 w-2/5 rounded-full bg-muted" />
                    <div className="h-4 w-full rounded-full bg-muted" />
                </div>
            </div>
        </div>
    );
}

export function MobiusSessionPane({
    session,
    initialMessage,
    unconfirmedMessage,
    botId,
    requests,
    onInitialMessageDelivered,
    onInitialMessageRecoveryCleared,
    onInitialMessageUnconfirmed,
    onStatusChange,
    onTitleChange,
}: {
    readonly session: OpenMobiusSession;
    readonly initialMessage?: QueuedDraftMessage | undefined;
    readonly unconfirmedMessage?: UnconfirmedSubmission | undefined;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "runtimeConfiguration">;
    readonly onInitialMessageDelivered?: (() => void) | undefined;
    readonly onInitialMessageRecoveryCleared?: ((commandId: string) => void) | undefined;
    readonly onInitialMessageUnconfirmed?: ((journal: UnconfirmedSubmission) => void) | undefined;
    readonly onStatusChange: (sessionId: string, status: SessionActivityState) => void;
    readonly onTitleChange: (sessionId: string, title: string) => void;
}) {
    const sessionId = session.result.ready.sessionId;
    const { clock } = useMortyApplication();
    const [pane] = useState(() =>
        createSessionPaneModel({
            clock,
            session,
            botId,
            requests,
            initialMessage,
            unconfirmedMessage,
            onInitialMessageDelivered,
            onInitialMessageRecoveryCleared,
            onInitialMessageUnconfirmed,
            onStatusChange: (status) => onStatusChange(sessionId, status),
            onTitleChange,
        }),
    );
    const model = useStore(pane.store);
    const attachmentModel = useStore(pane.composerAttachments);
    const interactionSubmissions = useStore(pane.interactionSubmissions);
    const interactions = sessionInteractionPresentation(model.interactions, interactionSubmissions);
    const preview = useStore(pane.filePreview);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const messageList = useRef<HTMLDivElement | null>(null);
    const titleInput = useRef<HTMLInputElement | null>(null);
    const titleEditorOpen = model.titleEdit.kind !== "closed";
    useEffect(() => {
        if (titleEditorOpen) {
            titleInput.current?.focus();
            titleInput.current?.select();
        }
    }, [titleEditorOpen]);
    const harnesses = model.harnesses;

    // The model owns the session connection through the same ref-cleanup
    // protocol the chat root uses: attach starts it, the cleanup detaches,
    // and the model's WeakSet latch ignores re-renders of the same element.

    const loadOlderMessages = useCallback(
        async (signal: AbortSignal) => await pane.store.getState().loadOlderMessages(signal),
        [pane],
    );

    const run = (action: (signal: AbortSignal) => Promise<void>) => {
        const signal = pane.operationsSignal();
        void action(signal).catch((cause: unknown) => {
            if (!signal.aborted) {
                reportApplicationError(cause, "session-pane-action");
            }
        });
    };
    const runAndFollow = (action: (signal: AbortSignal) => Promise<void>) => {
        if (messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
        run(action);
    };
    const respondToPermission = (response: PermissionInteractionResponse): void => {
        interactionSubmissions.respondToPermission(response, pane.operationsSignal());
    };
    const respondToElicitation = (response: ElicitationInteractionResponse): void => {
        interactionSubmissions.respondToElicitation(response, pane.operationsSignal());
    };
    const presentation = sessionPanePresentation(model, delivery, taskControls, messageQueue, attachmentModel);
    const renderItems = sessionRenderItems(model.messages);
    const sessionMessagesLoading = model.connection.kind === "loading";
    const configure = (option: SessionConfigOption, value: string, booleanValue: boolean) =>
        run(async (signal) => await pane.store.getState().configure(option, value, booleanValue, signal));
    const openLocalFile = useCallback(
        (path: string) => {
            void pane.filePreview.getState().open(path, pane.operationsSignal());
        },
        [pane],
    );
    const reloadLocalFile = useCallback(() => {
        void pane.filePreview.getState().reload(pane.operationsSignal());
    }, [pane]);

    const titleBarProps = {
        title: model.title,
        titleEdit: model.titleEdit,
        titleLoading: sessionMessagesLoading,
        titleInput,
        onOpenTitleEdit: () => pane.store.getState().openTitleEdit(),
        onSetTitleDraft: (draft: string) => pane.store.getState().setTitleDraft(draft),
        onCancelTitleEdit: () => pane.store.getState().cancelTitleEdit(),
        onConfirmTitleEdit: () => run(async (signal) => await pane.store.getState().confirmTitleEdit(signal)),
    };

    return (
        <>
            <section className={chatSessionPaneSectionClassName} ref={pane.onAttach}>
                <header className="hidden h-12 shrink-0 items-center gap-1 px-6 sm:flex">
                    <SessionConversationTitleBar {...titleBarProps} centered={false} />
                </header>
                <FollowLatestScrollArea
                    role="log"
                    container={messageList}
                    followThreshold={80}
                    followRevision={null}
                    showTopFade
                    aria-label="Messages"
                    className={chatSessionMessageScrollClassName}
                >
                    {sessionMessagesLoading && <SessionMessageListSkeleton />}
                    {!sessionMessagesLoading && model.messages.length === 0 && model.connection.kind === "failed" && (
                        <div
                            className={`${chatSessionMessageColumnClassName} flex min-h-full items-center justify-center`}
                        >
                            <div className="grid w-full max-w-lg justify-items-center gap-4 text-center">
                                <p data-testid={dataTestId.sessionLoadFailure} role="alert">
                                    {model.connection.message}
                                </p>
                                <Button
                                    onClick={() => run(async (signal) => await pane.store.getState().connect(signal))}
                                    variant="outline"
                                >
                                    Reconnect
                                </Button>
                            </div>
                        </div>
                    )}
                    {!sessionMessagesLoading &&
                        model.messages.length === 0 &&
                        model.connection.kind === "ready" &&
                        model.activity.kind === "idle" &&
                        !model.historyLoading && (
                            <div className={chatSessionMessageColumnClassName}>
                                <p className="text-center text-sm text-muted-foreground" role="status">
                                    No message history is available for this session.
                                </p>
                            </div>
                        )}
                    {!sessionMessagesLoading && model.historyLoading && <OlderHistorySkeleton />}
                    {!sessionMessagesLoading && (
                        <div className={chatSessionMessageColumnClassName}>
                            {renderItems.map((item, index) => (
                                <div
                                    key={item.kind === "event" ? item.message.firstEvent.eventId : item.id}
                                    className={chatSessionMessageItemClassName}
                                >
                                    {item.kind === "assistant-text" ? (
                                        <MobiusAssistantText
                                            openLocalFile={openLocalFile}
                                            readImage={pane.readResource}
                                            text={item.text}
                                            streaming={
                                                model.activity.kind === "working" && index === renderItems.length - 1
                                            }
                                        />
                                    ) : item.kind === "thinking" ? (
                                        <div data-testid={dataTestId.agentResponse}>
                                            <AgentThinking
                                                active={
                                                    model.activity.kind === "working" &&
                                                    index === renderItems.length - 1
                                                }
                                                entries={item.entries}
                                                readImage={pane.readResource}
                                            />
                                        </div>
                                    ) : (
                                        <MobiusSessionMessage
                                            active={
                                                model.activity.kind === "working" && index === renderItems.length - 1
                                            }
                                            failureApproval={{ botId, kind: "bot-approval" }}
                                            message={item.message}
                                            deliveryUnknownUserMessageId={presentation.deliveryUnknownUserMessageId}
                                            onRemoveUnknownDelivery={pane.store.getState().removeUnknownDelivery}
                                            onRetryUnknownDelivery={() =>
                                                run(pane.store.getState().retryUnknownDelivery)
                                            }
                                            readImage={pane.readResource}
                                            openLocalFile={openLocalFile}
                                        />
                                    )}
                                </div>
                            ))}
                            {presentation.unconfirmedDelivery !== null && (
                                <UnconfirmedDeliveryCard
                                    delivery={presentation.unconfirmedDelivery}
                                    onRemove={() => pane.store.getState().removeUnknownDelivery()}
                                    onRetry={() => run(pane.store.getState().retryUnknownDelivery)}
                                />
                            )}
                            {presentation.workingIndicatorVisible &&
                                presentation.outputState !== "idle" &&
                                model.activity.kind === "working" && (
                                    <div className="mt-6">
                                        <WorkingIndicator startedAt={model.activity.startedAt} />
                                    </div>
                                )}
                        </div>
                    )}
                </FollowLatestScrollArea>
                <LoadMoreTrigger
                    label="Load older messages"
                    container={messageList}
                    hasMore={model.hasOlderHistory}
                    loading={model.historyLoading}
                    onLoadMore={loadOlderMessages}
                    revision={model.historyRevision}
                />
                <ChatMessageQueue
                    messages={messageQueue.messages}
                    steeringSupported={taskControls.steeringSupported}
                    onDelete={(commandId) =>
                        run(async (signal) => await pane.store.getState().deleteQueued(commandId, signal))
                    }
                    onSteer={(commandId) =>
                        runAndFollow(async (signal) => await pane.store.getState().steerQueued(commandId, signal))
                    }
                />
                {(interactions.elicitations.length > 0 || interactions.permissions.length > 0) && (
                    <div
                        className={`${chatSessionColumnClassName} mt-4 max-h-[50vh] shrink-0 overflow-y-auto [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:mt-5`}
                    >
                        <SessionInteractionCards
                            elicitations={interactions.elicitations}
                            permissions={interactions.permissions}
                            busyInteractionIds={interactions.busyInteractionIds}
                            error={interactions.error}
                            onElicitationResponse={respondToElicitation}
                            onPermissionResponse={respondToPermission}
                        />
                    </div>
                )}
                <BotChatComposer
                    attachmentModel={attachmentModel}
                    attachmentSignal={pane.operationsSignal()}
                    disabled={presentation.composerDisabled}
                    draft={model.draft}
                    error={presentation.composerError}
                    errorStatus={
                        model.connection.kind === "disconnected" || model.connection.kind === "reconnecting" ? (
                            <SessionReconnectNotice
                                connection={model.connection}
                                onRetryNow={() => pane.store.getState().retryNow()}
                            />
                        ) : undefined
                    }
                    onDraftChange={pane.store.getState().setDraft}
                    onStop={() => run(pane.store.getState().stop)}
                    onSubmit={() =>
                        runAndFollow(
                            presentation.shouldQueueOnSubmit
                                ? pane.store.getState().queueDraft
                                : pane.store.getState().send,
                        )
                    }
                    outputState={presentation.outputState}
                    submitDisabled={presentation.submitDisabled}
                >
                    <ChatConfigurationMenu
                        controls={[
                            {
                                disabled: true,
                                harnessLockedLabel: "The harness cannot be changed for an existing session.",
                                id: "harness",
                                kind: "select" as const,
                                label: "Harness",
                                locked: true,
                                onValueChange: () => {},
                                options: harnesses.some(
                                    (harness) => harness.value.split(":").at(-1) === session.agentRef,
                                )
                                    ? harnesses
                                    : [
                                          ...harnesses,
                                          {
                                              agentRef: session.agentRef,
                                              label: session.agentRef,
                                              value: session.agentRef,
                                          },
                                      ],
                                value:
                                    harnesses.find((harness) => harness.value.split(":").at(-1) === session.agentRef)
                                        ?.value ?? session.agentRef,
                            },
                            ...model.options.map((option) =>
                                option.type === "boolean"
                                    ? {
                                          checked: option.booleanValue,
                                          disabled: presentation.busy,
                                          id: option.id,
                                          kind: "boolean" as const,
                                          label: option.name,
                                          onCheckedChange: () => configure(option, "", !option.booleanValue),
                                          testId: dataTestId.agentSetting(option.id),
                                      }
                                    : {
                                          disabled: presentation.busy,
                                          id: option.id,
                                          kind: "select" as const,
                                          label: option.name,
                                          onValueChange: (value: string) => configure(option, value, false),
                                          options: option.values.map((value) => ({
                                              value: value.value,
                                              label: value.name,
                                          })),
                                          searchable: option.category === "model",
                                          testId: dataTestId.agentSetting(option.id),
                                          value: option.currentValue,
                                      },
                            ),
                        ]}
                        settingsLoading={model.operation.kind === "configuring"}
                    />
                    {model.operation.kind === "configuring" && (
                        <span role="status" className="sr-only">
                            Updating agent settings…
                        </span>
                    )}
                </BotChatComposer>
            </section>
            <MobileSessionTitlePortal>
                <SessionConversationTitleBar {...titleBarProps} centered />
            </MobileSessionTitlePortal>
            <FilePreview
                onClose={preview.close}
                layout={preview.layout}
                onPanelAttach={preview.onPanelAttach}
                onToggleExpanded={preview.toggleExpanded}
                onHtmlAttach={preview.onHtmlAttach}
                onHtmlView={preview.showHtml}
                onReload={reloadLocalFile}
                state={preview.state}
            />
        </>
    );
}
