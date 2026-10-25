import type { PromptImage, PromptResource, SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { Check, CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { AgentThinking, type AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import { AutoFocusInput } from "../../components/chat/auto-focus-input.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import {
    chatSessionAgentReplyGroupClassName,
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionMessageColumnClassName,
    chatSessionMessageItemClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { ReadonlyWorkingDirectory, WorkingDirectorySkeleton } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { MobileSessionTitlePortal } from "../../components/chat/mobile-session-title-portal.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { WorkingIndicator } from "../../components/chat/working-indicator.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { cn } from "../../lib/utils.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { sessionExecutionContext } from "../../view-models/chat/execution-context.ts";
import { harnessOptions } from "../../view-models/chat/native-session-agents.ts";
import { sessionInteractionPresentation } from "../../view-models/chat/session-interaction-store.ts";
import { type SessionPaneModel, sessionPanePresentation } from "../../view-models/chat/session-pane-store.ts";
import { type SessionMessage, sessionTextValue } from "../../view-models/chat/session-presentation.ts";
import { createSessionResourceStore } from "../../view-models/chat/session-resource-store.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { ChatMessageQueue } from "./chat-message-queue.tsx";
import { FilePreview } from "./file-preview.tsx";
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

function sessionRenderItems(messages: readonly SessionMessage[]): readonly SessionRenderItem[] {
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

type SessionRenderGroup =
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "agent-reply";
      }
    | {
          readonly id: string;
          readonly item: SessionRenderItem;
          readonly kind: "user";
      };

function sessionRenderItemId(item: SessionRenderItem): string {
    return item.kind === "event" ? item.message.firstEvent.eventId : item.id;
}

function isUserSessionRenderItem(item: SessionRenderItem): boolean {
    return item.kind === "event" && item.message.role === "user";
}

function sessionRenderGroups(items: readonly SessionRenderItem[]): readonly SessionRenderGroup[] {
    const groups: SessionRenderGroup[] = [];
    let replyItems: SessionRenderItem[] = [];

    const flushReplyGroup = (): void => {
        if (replyItems.length === 0) {
            return;
        }
        const firstReplyItem = replyItems.at(0);
        if (firstReplyItem === undefined) {
            return;
        }
        groups.push({ id: sessionRenderItemId(firstReplyItem), items: replyItems, kind: "agent-reply" });
        replyItems = [];
    };

    for (const item of items) {
        if (isUserSessionRenderItem(item)) {
            flushReplyGroup();
            groups.push({ id: sessionRenderItemId(item), item, kind: "user" });
        } else {
            replyItems.push(item);
        }
    }
    flushReplyGroup();
    return groups;
}

function SessionRenderItemContent({
    active,
    item,
    onRetryUnknownDelivery,
    onRemoveUnknownDelivery,
    openLocalFile,
    pane,
    presentation,
}: {
    readonly active: boolean;
    readonly item: SessionRenderItem;
    readonly onRemoveUnknownDelivery: () => void;
    readonly onRetryUnknownDelivery: () => void;
    readonly openLocalFile: (path: string) => void;
    readonly pane: SessionPaneModel;
    readonly presentation: Pick<ReturnType<typeof sessionPanePresentation>, "deliveryUnknownUserMessageId">;
}) {
    if (item.kind === "assistant-text") {
        return (
            <MobiusAssistantText
                createResourceStore={createSessionResourceStore}
                openLocalFile={openLocalFile}
                readImage={pane.readResource}
                text={item.text}
                streaming={active}
            />
        );
    }
    if (item.kind === "thinking") {
        return (
            <div data-testid={dataTestId.agentResponse}>
                <AgentThinking
                    active={active}
                    createResourceStore={createSessionResourceStore}
                    entries={item.entries}
                    readImage={pane.readResource}
                />
            </div>
        );
    }
    return (
        <MobiusSessionMessage
            active={active}
            deliveryUnknownUserMessageId={presentation.deliveryUnknownUserMessageId}
            failureApproval={{ botId: pane.botId, kind: "bot-approval" }}
            message={item.message}
            onRemoveUnknownDelivery={onRemoveUnknownDelivery}
            onRetryUnknownDelivery={onRetryUnknownDelivery}
            openLocalFile={openLocalFile}
            readImage={pane.readResource}
        />
    );
}

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
                    className={cn(
                        "w-40 max-w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none",
                        centered ? "h-5" : "h-4",
                    )}
                />
            </div>
        </h2>
    );
}

function SessionConversationTitleBar({
    title,
    titleEdit,
    titleLoading,
    centered,
    agentRef,
    agentLabel,
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
    readonly centered: boolean;
    readonly agentRef: string;
    readonly agentLabel: string;
    readonly onOpenTitleEdit: () => void;
    readonly onSetTitleDraft: (draft: string) => void;
    readonly onCancelTitleEdit: () => void;
    readonly onConfirmTitleEdit: () => void;
}) {
    const displayTitle = title || "Untitled session";
    const titleTextClassName = centered ? "text-[14px] leading-5" : "text-sm";
    const harnessMarkClassName = cn("text-copy-secondary", centered && "size-[18px]");
    if (titleEdit.kind === "closed" || centered) {
        if (titleLoading) {
            return <SessionTitleSkeleton centered={centered} />;
        }
        return (
            <h2
                className={cn(
                    "flex min-w-0 items-center font-semibold",
                    titleTextClassName,
                    centered ? "w-full max-w-full justify-center gap-1" : "gap-2",
                )}
                title={displayTitle}
            >
                <HarnessMark
                    agentRef={agentRef || agentLabel}
                    appearance="line"
                    className={harnessMarkClassName}
                    label={agentLabel}
                    testId={dataTestId.sessionTitleHarnessMark}
                />
                {centered ? (
                    <span className="min-w-0 max-w-full truncate text-center">{displayTitle}</span>
                ) : (
                    <button
                        type="button"
                        aria-label={displayTitle}
                        className="min-w-0 max-w-full cursor-pointer truncate text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/70"
                        title="Rename conversation"
                        onClick={onOpenTitleEdit}
                    >
                        {displayTitle}
                    </button>
                )}
            </h2>
        );
    }
    const saving = titleEdit.kind === "saving";
    return (
        <div
            className={cn(
                "flex min-w-0 items-center",
                centered ? "w-full max-w-full justify-center gap-1" : "flex-1 gap-2",
            )}
        >
            <HarnessMark
                agentRef={agentRef || agentLabel}
                appearance="line"
                className={harnessMarkClassName}
                label={agentLabel}
                testId={dataTestId.sessionTitleHarnessMark}
            />
            <AutoFocusInput
                aria-label="Conversation title"
                className={cn(
                    "min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-0 py-0 font-semibold shadow-none outline-none ring-0 focus:ring-0 focus-visible:ring-0",
                    titleTextClassName,
                    centered && "text-center",
                )}
                disabled={saving}
                maxLength={500}
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
            <div className="flex shrink-0 items-center gap-1">
                <Button
                    aria-label="Cancel rename"
                    disabled={saving}
                    size="icon"
                    variant="ghost"
                    onClick={onCancelTitleEdit}
                >
                    <X className="size-4" />
                </Button>
                <Button
                    aria-label="Save title"
                    disabled={saving}
                    size="icon"
                    variant="ghost"
                    onClick={onConfirmTitleEdit}
                >
                    <Check className="size-4" />
                </Button>
            </div>
        </div>
    );
}

function MobiusSessionPaneShell({
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
                className={cn(chatSessionExecutionHeaderClassName, mobileTitlePortaled ? "hidden sm:flex" : "flex")}
            >
                {titleLoading ? (
                    <SessionTitleSkeleton />
                ) : (
                    <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>
                        {title}
                    </h2>
                )}
                {titleLoading ? <WorkingDirectorySkeleton /> : null}
            </header>
            {children}
            {footer}
        </section>
    );
}

export function MobiusSessionPaneLoading({ footer, title }: { readonly footer?: ReactNode; readonly title: string }) {
    return (
        <DesktopChatLayout>
            {(desktop) => (
                <>
                    <MobiusSessionPaneShell footer={footer} mobileTitlePortaled={!desktop} title={title}>
                        <div aria-label="Messages" className={chatSessionMessageScrollClassName} role="log">
                            <SessionMessageListSkeleton />
                        </div>
                    </MobiusSessionPaneShell>
                    {desktop ? null : (
                        <MobileSessionTitlePortal>
                            <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
                        </MobileSessionTitlePortal>
                    )}
                </>
            )}
        </DesktopChatLayout>
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

export function MobiusSessionPane({ workspace }: { readonly workspace: ChatWorkspace }) {
    // The workspace owns the pane model outside React; the keyed view reads
    // it and hands it to the pane body, which subscribes to its stores. The
    // pane for a ready selection is always built before the view renders
    // through it; the empty stand-in covers the gap without conditional
    // hooks.
    const pane = workspace.sessionPane();
    if (pane === null) {
        return <section className={chatSessionPaneSectionClassName} />;
    }
    return <MobiusSessionPaneBody pane={pane} workspace={workspace} />;
}

function MobiusSessionPaneBody({
    pane,
    workspace,
}: {
    readonly pane: SessionPaneModel;
    readonly workspace: ChatWorkspace;
}) {
    const home = useStore(workspace.home);
    const runtimeConfiguration = home.runtimeConfiguration;
    const model = useStore(pane.store);
    const attachmentModel = useStore(pane.composerAttachments);
    const interactionModel = useStore(pane.interactions);
    const settingsModel = useStore(pane.settings);
    const interactions = sessionInteractionPresentation(interactionModel);
    const preview = useStore(pane.filePreview);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const harnesses = harnessOptions(runtimeConfiguration?.runtime ?? null);

    // The model owns the session connection through the same ref-cleanup
    // protocol the chat root uses: attach starts it, the cleanup detaches,
    // and the model's WeakSet latch ignores re-renders of the same element.

    const run = (action: (signal: AbortSignal) => Promise<void>) => {
        const signal = pane.operationsSignal();
        void action(signal).catch((cause: unknown) => {
            if (!signal.aborted) {
                reportApplicationError(cause, "session-pane-action");
            }
        });
    };
    const runAndFollow = (action: (signal: AbortSignal) => Promise<void>) => {
        run(action);
    };
    const respondToPermission = (response: PermissionInteractionResponse): void => {
        interactionModel.respondToPermission(response, pane.operationsSignal());
    };
    const respondToElicitation = (response: ElicitationInteractionResponse): void => {
        interactionModel.respondToElicitation(response, pane.operationsSignal());
    };
    const presentation = sessionPanePresentation(
        model,
        delivery,
        taskControls,
        messageQueue,
        attachmentModel,
        interactionModel,
    );
    const renderItems = sessionRenderItems(model.messages);
    const renderGroups = sessionRenderGroups(renderItems);
    const lastRenderItemIndex = renderItems.length - 1;
    const workingStartedAt =
        presentation.workingIndicatorVisible && presentation.outputState !== "idle" && model.activity.kind === "working"
            ? model.activity.startedAt
            : null;
    const lastRenderGroup = renderGroups.at(-1);
    const workingIndicatorFollowsReply =
        workingStartedAt !== null &&
        presentation.unconfirmedDelivery === null &&
        lastRenderGroup?.kind === "agent-reply";
    const sessionMessagesLoading = model.connection.kind === "loading" && model.messages.length === 0;
    const initialMessage = model.pendingInitialMessage;
    const configure = (option: SessionConfigOption, value: string, booleanValue: boolean) =>
        run(async (signal) => await pane.store.getState().configure(option, value, booleanValue, signal));
    const openLocalFile = (path: string) => {
        void pane.filePreview.getState().open(path, pane.operationsSignal());
    };
    const reloadLocalFile = () => {
        void pane.filePreview.getState().reload(pane.operationsSignal());
    };

    const executionContext = sessionExecutionContext(pane.session, home, model.connection);
    const workingDirectoryLabel = executionContext.directory ?? executionContext.directoryPlaceholder;
    const titleBarProps = {
        title: model.title,
        titleEdit: model.titleEdit,
        titleLoading: sessionMessagesLoading,
        agentRef: executionContext.agentRef,
        agentLabel: executionContext.agent,
        onOpenTitleEdit: () => pane.store.getState().openTitleEdit(),
        onSetTitleDraft: (draft: string) => pane.store.getState().setTitleDraft(draft),
        onCancelTitleEdit: () => pane.store.getState().cancelTitleEdit(),
        onConfirmTitleEdit: () => run(async (signal) => await pane.store.getState().confirmTitleEdit(signal)),
    };

    return (
        <DesktopChatLayout>
            {(desktop) => (
                <>
                    <section className={chatSessionPaneSectionClassName} ref={pane.onAttach}>
                        {desktop ? (
                            <header className={chatSessionExecutionHeaderClassName}>
                                <div className="min-w-0 flex-1">
                                    <SessionConversationTitleBar {...titleBarProps} centered={false} />
                                </div>
                                {sessionMessagesLoading ? (
                                    <WorkingDirectorySkeleton />
                                ) : (
                                    <ReadonlyWorkingDirectory
                                        className="shrink-0"
                                        directoryLabel={workingDirectoryLabel}
                                        tooltipSide="bottom"
                                    />
                                )}
                            </header>
                        ) : null}
                        <FollowLatestScrollArea
                            role="log"
                            followThreshold={80}
                            followRevision={model.followRevision}
                            showTopFade
                            aria-label="Messages"
                            className={chatSessionMessageScrollClassName}
                            loadOlder={{
                                hasMore: model.hasOlderHistory,
                                loading: model.historyLoading,
                                onLoadMore: (signal) => pane.store.getState().loadOlderMessages(signal),
                                revision: model.historyRevision,
                            }}
                        >
                            {sessionMessagesLoading && <SessionMessageListSkeleton />}
                            {!sessionMessagesLoading &&
                                model.messages.length === 0 &&
                                model.connection.kind === "failed" && (
                                    <div
                                        className={`${chatSessionMessageColumnClassName} flex min-h-full items-center justify-center`}
                                    >
                                        <div className="grid w-full max-w-lg justify-items-center gap-4 text-center">
                                            <SessionLoadFailure message={model.connection.message} />
                                            <Button
                                                onClick={() =>
                                                    run(async (signal) => await pane.store.getState().connect(signal))
                                                }
                                                variant="outline"
                                            >
                                                Reconnect
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            {!sessionMessagesLoading &&
                                initialMessage === null &&
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
                                    {initialMessage !== null && (
                                        <div className={chatSessionMessageItemClassName}>
                                            <UserPromptMessage
                                                text={initialMessage.content}
                                                images={initialMessage.attachments.flatMap((attachment) =>
                                                    attachment.kind === "image" ? [attachment.image] : [],
                                                )}
                                                resources={initialMessage.attachments.flatMap((attachment) =>
                                                    attachment.kind === "resource" ? [attachment.resource] : [],
                                                )}
                                            />
                                        </div>
                                    )}
                                    {(() => {
                                        let flatIndex = 0;
                                        return renderGroups.map((group, groupIndex) => {
                                            if (group.kind === "user") {
                                                const active =
                                                    model.activity.kind === "working" &&
                                                    flatIndex === lastRenderItemIndex;
                                                const item = group.item;
                                                flatIndex += 1;
                                                return (
                                                    <div key={group.id} className={chatSessionMessageItemClassName}>
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            item={item}
                                                            onRemoveUnknownDelivery={
                                                                pane.store.getState().removeUnknownDelivery
                                                            }
                                                            onRetryUnknownDelivery={() =>
                                                                run(pane.store.getState().retryUnknownDelivery)
                                                            }
                                                            openLocalFile={openLocalFile}
                                                            pane={pane}
                                                            presentation={presentation}
                                                        />
                                                    </div>
                                                );
                                            }
                                            const showWorkingInGroup =
                                                workingIndicatorFollowsReply &&
                                                workingStartedAt !== null &&
                                                groupIndex === renderGroups.length - 1;
                                            const replyItems = group.items.map((item) => {
                                                const active =
                                                    model.activity.kind === "working" &&
                                                    flatIndex === lastRenderItemIndex;
                                                flatIndex += 1;
                                                return (
                                                    <div key={sessionRenderItemId(item)}>
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            item={item}
                                                            onRemoveUnknownDelivery={
                                                                pane.store.getState().removeUnknownDelivery
                                                            }
                                                            onRetryUnknownDelivery={() =>
                                                                run(pane.store.getState().retryUnknownDelivery)
                                                            }
                                                            openLocalFile={openLocalFile}
                                                            pane={pane}
                                                            presentation={presentation}
                                                        />
                                                    </div>
                                                );
                                            });
                                            if (showWorkingInGroup && workingStartedAt !== null) {
                                                return (
                                                    <div
                                                        key={group.id}
                                                        className={cn(chatSessionMessageItemClassName, "pb-8")}
                                                    >
                                                        <div className="space-y-4">{replyItems}</div>
                                                        <div className="mt-3">
                                                            <WorkingIndicator startedAt={workingStartedAt} />
                                                        </div>
                                                    </div>
                                                );
                                            }
                                            return (
                                                <div key={group.id} className={chatSessionAgentReplyGroupClassName}>
                                                    {replyItems}
                                                </div>
                                            );
                                        });
                                    })()}
                                    {presentation.unconfirmedDelivery !== null && (
                                        <UnconfirmedDeliveryCard
                                            delivery={presentation.unconfirmedDelivery}
                                            onRemove={() => pane.store.getState().removeUnknownDelivery()}
                                            onRetry={() => run(pane.store.getState().retryUnknownDelivery)}
                                        />
                                    )}
                                    {workingStartedAt !== null && !workingIndicatorFollowsReply && (
                                        <div className="mt-3">
                                            <WorkingIndicator startedAt={workingStartedAt} />
                                        </div>
                                    )}
                                </div>
                            )}
                        </FollowLatestScrollArea>
                        <ChatMessageQueue
                            messages={messageQueue.messages}
                            steeringSupported={taskControls.steeringSupported}
                            onDelete={(commandId) =>
                                run(async (signal) => await pane.store.getState().deleteQueued(commandId, signal))
                            }
                            onSteer={(commandId) =>
                                runAndFollow(
                                    async (signal) => await pane.store.getState().steerQueued(commandId, signal),
                                )
                            }
                        />
                        {(interactions.elicitations.length > 0 || interactions.permissions.length > 0) && (
                            <ScrollEdgeFade
                                fadeFromClassName="from-card"
                                fadeToClassName="to-card/0"
                                frameClassName={`${chatSessionColumnClassName} mt-4 shrink-0 sm:mt-5`}
                                className="max-h-[50vh] overflow-y-auto [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]"
                            >
                                <SessionInteractionCards
                                    elicitations={interactions.elicitations}
                                    permissions={interactions.permissions}
                                    busyInteractionIds={interactions.busyInteractionIds}
                                    error={interactions.error}
                                    onElicitationResponse={respondToElicitation}
                                    onPermissionResponse={respondToPermission}
                                    onStop={() => run(pane.store.getState().stop)}
                                />
                            </ScrollEdgeFade>
                        )}
                        <BotChatComposer
                            attachmentModel={attachmentModel}
                            attachmentSignal={pane.operationsSignal()}
                            disabled={presentation.composerInputDisabled}
                            draft={model.connection.kind === "session-loading-after-create" ? "" : model.draft}
                            error={presentation.composerError}
                            errorStatus={
                                executionContext.feedback.kind === "hidden" ? undefined : (
                                    <ConnectionNotice
                                        feedback={executionContext.feedback}
                                        onRetryNow={pane.store.getState().retryNow}
                                        onReopen={() => run(pane.store.getState().reopen)}
                                    />
                                )
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
                                            (harness) => harness.value.split(":").at(-1) === pane.agentRef,
                                        )
                                            ? harnesses
                                            : [
                                                  ...harnesses,
                                                  {
                                                      agentRef: pane.agentRef,
                                                      label: pane.agentRef,
                                                      value: pane.agentRef,
                                                  },
                                              ],
                                        value:
                                            harnesses.find(
                                                (harness) => harness.value.split(":").at(-1) === pane.agentRef,
                                            )?.value ?? pane.agentRef,
                                    },
                                    ...settingsModel.options.map((option) =>
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
                    {desktop ? null : (
                        <MobileSessionTitlePortal>
                            <div className="mt-1 flex min-w-0 w-full flex-col items-center">
                                <SessionConversationTitleBar {...titleBarProps} centered />
                                {sessionMessagesLoading ? (
                                    <WorkingDirectorySkeleton className="mt-0.5 h-5 max-w-full" />
                                ) : (
                                    <ReadonlyWorkingDirectory
                                        className="-mb-1.5 min-h-0 max-w-full gap-1 py-0 text-[11px] font-normal text-morty-text-3"
                                        clip="end"
                                        directoryLabel={workingDirectoryLabel}
                                        iconClassName="size-3"
                                        tooltipSide="bottom"
                                    />
                                )}
                            </div>
                        </MobileSessionTitlePortal>
                    )}
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
            )}
        </DesktopChatLayout>
    );
}
