import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { Check, CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { dataTestId } from "@/data-testid";
import { AgentThinking, type AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import { AuthenticationNotice } from "../../components/chat/authentication-notice.tsx";
import { AutoFocusInput } from "../../components/chat/auto-focus-input.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { ChatConfigurationMenu } from "../../components/chat/chat-configuration-menu.tsx";
import {
    chatSessionAgentReplyGroupClassName,
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionInteractionColumnClassName,
    chatSessionMessageColumnClassName,
    chatSessionMessageItemClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneFillClassName,
} from "../../components/chat/chat-session-layout.ts";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { ReadonlyWorkingDirectory, WorkingDirectorySkeleton } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { MessageDeliveryStatus } from "../../components/chat/message-delivery-status.tsx";
import { MobileRenameOverlay } from "../../components/chat/mobile-rename-overlay.tsx";
import { MobileSessionTitlePortal } from "../../components/chat/mobile-session-title-portal.tsx";
import { ResponseCopyButton } from "../../components/chat/response-copy-button.tsx";
import {
    type ElicitationInteractionResponse,
    type PermissionInteractionResponse,
    SessionInteractionCards,
} from "../../components/chat/session-interactions.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { SessionWelcome } from "../../components/chat/session-welcome.tsx";
import { isFileEditToolCall } from "../../components/chat/tools/tool-renderer-registry.tsx";
import { TurnWorkDisclosure, type TurnWorkSummary } from "../../components/chat/turn-work-disclosure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { WorkingIndicator } from "../../components/chat/working-indicator.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { cn } from "../../lib/utils.ts";
import { agentReplyCopyText, agentReplyMessageGroups } from "../../view-models/chat/agent-reply-copy.ts";
import { authenticationGuidance } from "../../view-models/chat/authentication-guidance.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { canAddAttachments } from "../../view-models/chat/composer-attachment-store.ts";
import { sessionExecutionContext } from "../../view-models/chat/execution-context.ts";
import { sessionHarnessSelection } from "../../view-models/chat/native-session-agents.ts";
import { createResponseCopyStore } from "../../view-models/chat/response-copy-store.ts";
import { sessionInteractionPresentation } from "../../view-models/chat/session-interaction-store.ts";
import { queuedMessages } from "../../view-models/chat/session-message-queue-store.ts";
import {
    type SessionPaneModel,
    sessionPanePresentation,
    type TitleEdit,
} from "../../view-models/chat/session-pane-store.ts";
import {
    type SessionMessage,
    sessionExecutionStates,
    sessionTextValue,
} from "../../view-models/chat/session-presentation.ts";
import { createSessionResourceStore } from "../../view-models/chat/session-resource-store.ts";
import { sessionTitle } from "../../view-models/chat/session-titles-store.ts";
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

type ReplyContentSection =
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "visible";
      }
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "process";
          readonly summary: TurnWorkSummary;
      };

function isProcessRenderItem(item: SessionRenderItem): boolean {
    // Compaction already has its own summary disclosure. Keep its marker visible
    // at the native event position rather than burying it in a process group.
    return item.kind === "thinking";
}

function isGeneratingProcessRenderItem(item: SessionRenderItem): boolean {
    if (item.kind === "thinking") {
        const current = item.entries.at(-1);
        return (
            current?.kind === "reasoning" ||
            current?.state.kind === "running" ||
            (current?.state.kind === "background" && current.state.status === "running")
        );
    }
    return (
        item.kind === "event" &&
        item.message.role === "assistant" &&
        item.message.presentation.kind === "compaction" &&
        item.message.presentation.status === "in_progress"
    );
}

/**
 * Whether a reply still has process work in flight. A generation the Agent drives natively reports no Morty turn,
 * so its reply settles only when every tool it started has an outcome; settled imports interrupt unresolved tools
 * when the Session opens, so this stays false for finished history.
 */
function hasRunningProcessWork(items: readonly SessionRenderItem[]): boolean {
    return items.some((item) => {
        if (item.kind === "thinking") {
            return item.entries.some(
                (entry) =>
                    entry.kind === "tool" &&
                    (entry.state.kind === "running" ||
                        (entry.state.kind === "background" && entry.state.status === "running")),
            );
        }
        return (
            item.kind === "event" &&
            item.message.role === "assistant" &&
            item.message.presentation.kind === "compaction" &&
            item.message.presentation.status === "in_progress"
        );
    });
}

function processSummary(items: readonly SessionRenderItem[]): TurnWorkSummary {
    const entries = items.flatMap((item) => (item.kind === "thinking" ? item.entries : []));
    const tools = entries.filter((entry) => entry.kind === "tool");
    return {
        failed: tools.filter(
            (entry) =>
                entry.state.kind === "failed" || (entry.state.kind === "background" && entry.state.status === "failed"),
        ).length,
        backgroundRunning: tools.filter((tool) => tool.state.kind === "background" && tool.state.status === "running")
            .length,
        backgroundUnknown: tools.filter((tool) => tool.state.kind === "background" && tool.state.status === "unknown")
            .length,
        fileEdits: tools.filter(isFileEditToolCall).length,
        interrupted: tools.filter(
            (entry) =>
                entry.state.kind === "interrupted" ||
                (entry.state.kind === "background" && entry.state.status === "stopped"),
        ).length,
        steps: Math.max(tools.length, items.length),
    };
}

/**
 * Groups adjacent weakened process rows until visible answer text starts the
 * next section. A process section remains disclosed during generation and
 * after completion so the answer leads; its summary carries the live shimmer
 * while the owning execution is still running.
 */
function agentReplySections(items: readonly SessionRenderItem[]): readonly ReplyContentSection[] {
    const sections: ReplyContentSection[] = [];
    let index = 0;
    while (index < items.length) {
        const item = items[index];
        if (item === undefined) {
            break;
        }
        if (isProcessRenderItem(item)) {
            const start = index;
            while (true) {
                const candidate = items[index];
                if (candidate === undefined || !isProcessRenderItem(candidate)) {
                    break;
                }
                index += 1;
            }
            const processItems = items.slice(start, index);
            const summary = processSummary(processItems);
            sections.push({
                id: `process:${sessionRenderItemId(processItems[0] ?? item)}`,
                items: processItems,
                kind: "process",
                summary,
            });
            continue;
        }
        const start = index;
        index += 1;
        const visibleItems = items.slice(start, index);
        sections.push({
            id: `visible:${sessionRenderItemId(visibleItems[0] ?? item)}`,
            items: visibleItems,
            kind: "visible",
        });
    }
    return sections;
}

/**
 * Vertical spacing class per reply display item: answer text carries no block
 * margin, process groups and notices declare 12px, failure cards 16px. The
 * article is a plain block flow, so adjacent declared margins collapse to the
 * larger value; first and last edges stay clear.
 */
type ReplyItemSpacing = "alert" | "block" | "text";

function replyItemSpacing(item: SessionRenderItem): ReplyItemSpacing {
    if (item.kind === "assistant-text") {
        return "text";
    }
    if (item.kind === "event" && item.message.role === "assistant" && item.message.presentation.kind === "failure") {
        return "alert";
    }
    return "block";
}

const replyItemSpacingMargins: Record<ReplyItemSpacing, { readonly mb: string; readonly mt: string }> = {
    alert: { mb: "mb-4", mt: "mt-4" },
    block: { mb: "mb-3", mt: "mt-3" },
    text: { mb: "", mt: "" },
};

function replyItemMarginClassName(spacing: ReplyItemSpacing, first: boolean, last: boolean): string {
    const margins = replyItemSpacingMargins[spacing];
    return cn(first ? "" : margins.mt, last ? "" : margins.mb);
}

function SessionRenderItemContent({
    active,
    item,
    machineName,
    onRetryUnknownDelivery,
    onRemoveUnknownDelivery,
    openLocalFile,
    pane,
    presentation,
}: {
    readonly active: boolean;
    readonly item: SessionRenderItem;
    readonly machineName: string;
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
            failureAgentRef={pane.agentRef}
            failureApproval={{ botId: pane.botId, kind: "bot-approval" }}
            failureMachineName={machineName}
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

/** While the phone rename overlay is open, the header keeps stating the committed title. */
const CLOSED_TITLE_EDIT: TitleEdit = { kind: "closed" };

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
    readonly titleEdit: TitleEdit;
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
    const titleHarnessMark = (loading: boolean) =>
        centered ? null : (
            <HarnessMark
                agentRef={agentRef || agentLabel}
                appearance="line"
                className="text-copy-secondary"
                label={agentLabel}
                loading={loading}
                testId={dataTestId.sessionTitleHarnessMark}
            />
        );
    if (titleEdit.kind === "closed" || titleEdit.kind === "failed") {
        if (titleLoading) {
            return (
                <h2
                    className={cn(
                        "flex min-w-0 items-center font-semibold",
                        titleTextClassName,
                        centered ? "w-full max-w-full justify-center gap-1" : "gap-2.5",
                    )}
                >
                    {titleHarnessMark(true)}
                    <div aria-label="Loading conversation title" className="min-w-0 max-w-full" role="status">
                        <span className="sr-only">Loading conversation title</span>
                        <div
                            aria-hidden="true"
                            className={cn(
                                "max-w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none",
                                centered ? "h-5 w-28" : "h-4 w-40",
                            )}
                        />
                    </div>
                </h2>
            );
        }
        return (
            <h2
                className={cn(
                    "flex min-w-0 items-center font-semibold",
                    titleTextClassName,
                    centered ? "w-full max-w-full justify-center gap-1" : "gap-2.5",
                )}
                title={displayTitle}
            >
                {titleHarnessMark(false)}
                <button
                    type="button"
                    aria-label={displayTitle}
                    className={cn(
                        "min-w-0 max-w-full cursor-pointer truncate outline-none hover:text-primary keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70",
                        centered ? "text-center" : "text-left",
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
        <div
            className={cn(
                "flex items-center",
                centered ? "w-max min-w-[14rem] max-w-[70vw] justify-center gap-1" : "min-w-0 flex-1 gap-2.5",
            )}
        >
            {titleHarnessMark(false)}
            <AutoFocusInput
                aria-label="Conversation title"
                className={cn(
                    "appearance-none rounded-none border-0 bg-transparent px-0 py-0 font-semibold shadow-none outline-none ring-0 keyboard-focus:focus:ring-0 keyboard-focus:focus-visible:ring-0",
                    titleTextClassName,
                    centered ? "w-[10rem] min-w-[8rem] shrink text-center" : "min-w-0 flex-1",
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

/**
 * The conversation is being opened. Its title and messages arrive from the same
 * read, so both stand in as skeletons: a title shown here would appear and then
 * be withdrawn again while the loaded pane waits for that read.
 */
export function MobiusSessionPaneLoading({ footer }: { readonly footer?: ReactNode }) {
    return (
        <DesktopChatLayout>
            {(desktop) => (
                <>
                    <section className={chatSessionPaneFillClassName}>
                        <header
                            className={cn(chatSessionExecutionHeaderClassName, desktop ? "flex" : "hidden sm:flex")}
                        >
                            <SessionTitleSkeleton />
                            <WorkingDirectorySkeleton />
                        </header>
                        <div aria-label="Messages" className={chatSessionMessageScrollClassName} role="log">
                            <SessionMessageListSkeleton />
                        </div>
                        {footer}
                    </section>
                    {desktop ? null : (
                        <MobileSessionTitlePortal>
                            <SessionTitleSkeleton centered />
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
    retryDisabled,
    onRemove,
    onRetry,
}: {
    readonly delivery: {
        readonly commandId: string;
        readonly displayPrompt: string;
        readonly attachmentLabels: readonly { readonly name: string; readonly uri: string }[];
        readonly attachments: readonly ComposerAttachment[];
    };
    readonly retryDisabled: boolean;
    readonly onRemove: () => void;
    readonly onRetry: () => void;
}) {
    return (
        <div className={chatSessionMessageItemClassName} data-testid={dataTestId.unconfirmedDelivery}>
            <UserPromptMessage
                attachments={delivery.attachments}
                attachmentLabels={delivery.attachmentLabels}
                text={delivery.displayPrompt}
            />
            <div
                className="ml-auto flex max-w-[85%] items-center gap-3 rounded-lg border border-destructive/15 bg-destructive/5 py-2 pr-2 pl-3 text-xs leading-5 text-destructive"
                role="alert"
            >
                <button
                    aria-label="Retry message with unknown delivery"
                    className="inline-flex size-7 items-center justify-center rounded-full"
                    disabled={retryDisabled}
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
        return <section className={chatSessionPaneFillClassName} />;
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
    const title = useStore(workspace.titles, (state) =>
        sessionTitle(state.titles, pane.session.result.ready.sessionId),
    );
    const attachmentModel = useStore(pane.composerAttachments);
    const interactionModel = useStore(pane.interactions);
    const settingsModel = useStore(pane.settings);
    const interactions = sessionInteractionPresentation(interactionModel);
    const preview = useStore(pane.filePreview);
    const delivery = useStore(pane.delivery);
    const messageQueue = useStore(pane.messageQueue);
    const taskControls = useStore(pane.tasks);
    const welcome = useStore(pane.welcome, (state) => state.state);
    const harness = sessionHarnessSelection(runtimeConfiguration?.runtime ?? null, pane.agentRef);

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
    const executionContext = sessionExecutionContext(pane.session, home, model.connection);
    const presentation = sessionPanePresentation(
        model,
        delivery,
        taskControls,
        messageQueue,
        attachmentModel,
        interactionModel,
        executionContext.available,
    );
    const authenticationRecovery =
        presentation.authenticationFailure === null
            ? null
            : authenticationGuidance(presentation.authenticationFailure.code, pane.agentRef, executionContext.machine);
    const renderItems = sessionRenderItems(model.messages);
    const renderGroups = sessionRenderGroups(renderItems);
    const executionStates = sessionExecutionStates(model.messages, presentation.activity.kind === "working");
    const executionStateByItemId = new Map(
        model.messages.flatMap((message, index) => {
            const state = executionStates[index];
            return state === undefined ? [] : [[message.firstEvent.eventId, state] as const];
        }),
    );
    const replyMessagesByRenderGroupId = new Map(
        agentReplyMessageGroups(model.messages).map((group) => [group.id, group.messages] as const),
    );
    const lastRenderItemIndex = renderItems.length - 1;
    const generationActive = presentation.workingIndicator !== null && presentation.activity.kind === "working";
    const sessionMessagesLoading =
        model.connection.kind === "first-loading" &&
        model.messages.length === 0 &&
        presentation.awaitingMessage === null;
    const initialMessage = presentation.awaitingMessage;
    const configure = (option: SessionConfigOption, value: string, booleanValue: boolean) =>
        run(async (signal) => await pane.store.getState().configure(option, value, booleanValue, signal));
    const openLocalFile = (path: string) => {
        void pane.filePreview.getState().open(path, pane.operationsSignal());
    };
    const reloadLocalFile = () => {
        void pane.filePreview.getState().reload(pane.operationsSignal());
    };

    const workingDirectoryLabel = executionContext.directory ?? executionContext.directoryPlaceholder;
    const titleBarProps = {
        title,
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
                    <section className={chatSessionPaneFillClassName}>
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
                                        iconClassName="size-3"
                                        tooltipSide="bottom"
                                    />
                                )}
                            </header>
                        ) : null}
                        <FollowLatestScrollArea
                            role="log"
                            followThreshold={80}
                            followRevision={model.followRevision}
                            jumpToLatest={{
                                label: "Jump to latest message",
                                working: presentation.workingIndicator !== null,
                            }}
                            showTopFade
                            aria-label="Messages"
                            className={chatSessionMessageScrollClassName}
                            loadOlder={{
                                hasMore: model.hasOlderHistory,
                                loading: presentation.historyLoading,
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
                                            <Button onClick={() => pane.store.getState().retryNow()} variant="outline">
                                                Reconnect
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            {!sessionMessagesLoading &&
                                initialMessage === null &&
                                presentation.confirmedMessages.length === 0 &&
                                model.messages.length === 0 &&
                                model.connection.kind === "ready" &&
                                presentation.activity.kind === "idle" &&
                                !presentation.historyLoading && (
                                    <div className={chatSessionMessageColumnClassName}>
                                        <p className="text-center text-sm text-muted-foreground" role="status">
                                            No message history is available for this session.
                                        </p>
                                    </div>
                                )}
                            {!sessionMessagesLoading && presentation.historyLoading && <OlderHistorySkeleton />}
                            {!sessionMessagesLoading && (
                                <div className={chatSessionMessageColumnClassName}>
                                    {initialMessage !== null && (
                                        <div className={chatSessionMessageItemClassName}>
                                            <UserPromptMessage
                                                attachments={initialMessage.attachments}
                                                text={initialMessage.content}
                                            />
                                        </div>
                                    )}
                                    {(() => {
                                        let flatIndex = 0;
                                        return renderGroups.map((group, groupIndex) => {
                                            if (group.kind === "user") {
                                                const followsUserMessage =
                                                    groupIndex === 0
                                                        ? initialMessage !== null
                                                        : renderGroups[groupIndex - 1]?.kind === "user";
                                                const active = generationActive && flatIndex === lastRenderItemIndex;
                                                const item = group.item;
                                                flatIndex += 1;
                                                return (
                                                    <div
                                                        key={group.id}
                                                        className={cn(
                                                            chatSessionMessageItemClassName,
                                                            // The previous bubble already reserves its 32px
                                                            // copy-button strip; mt-1 keeps the former 36px
                                                            // bubble-to-bubble total.
                                                            followsUserMessage && "mt-1",
                                                        )}
                                                    >
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            item={item}
                                                            machineName={executionContext.machine}
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
                                            const firstIndex = flatIndex;
                                            flatIndex += group.items.length;
                                            const replyActive = generationActive && flatIndex > lastRenderItemIndex;
                                            const isRenderItemActive = (item: SessionRenderItem) =>
                                                replyActive &&
                                                firstIndex + group.items.indexOf(item) === lastRenderItemIndex;
                                            const renderItem = (item: SessionRenderItem, spacingClassName: string) => {
                                                const active = isRenderItemActive(item);
                                                return (
                                                    <div className={spacingClassName} key={sessionRenderItemId(item)}>
                                                        <SessionRenderItemContent
                                                            active={active}
                                                            item={item}
                                                            machineName={executionContext.machine}
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
                                            };
                                            const execution = executionStateByItemId.get(group.id) ?? { kind: "open" };
                                            const sections = agentReplySections(group.items);
                                            // A generation the Agent drives natively reports no Morty turn; its running
                                            // tools are the only live signal that it is still working.
                                            const replyGenerating = replyActive || hasRunningProcessWork(group.items);
                                            const copyText = agentReplyCopyText(
                                                replyMessagesByRenderGroupId.get(group.id) ?? [],
                                                execution,
                                                replyGenerating,
                                            );
                                            // Flatten the article children so positional margin clearing sees the
                                            // laid-out order, including the trailing copy action row. Items inside a
                                            // process disclosure clear first/last within the disclosure body instead.
                                            const replyChildren: {
                                                readonly key: string;
                                                readonly render: (spacingClassName: string) => ReactNode;
                                                readonly spacing: ReplyItemSpacing;
                                            }[] = [];
                                            sections.forEach((section, sectionIndex) => {
                                                if (section.kind === "process") {
                                                    replyChildren.push({
                                                        key: section.id,
                                                        render: (spacingClassName) => (
                                                            <TurnWorkDisclosure
                                                                className={spacingClassName}
                                                                key={section.id}
                                                                summary={section.summary}
                                                                working={
                                                                    replyActive &&
                                                                    sectionIndex === sections.length - 1 &&
                                                                    section.items.some(isGeneratingProcessRenderItem)
                                                                }
                                                            >
                                                                {section.items.map((item, index) =>
                                                                    renderItem(
                                                                        item,
                                                                        replyItemMarginClassName(
                                                                            replyItemSpacing(item),
                                                                            index === 0,
                                                                            index === section.items.length - 1,
                                                                        ),
                                                                    ),
                                                                )}
                                                            </TurnWorkDisclosure>
                                                        ),
                                                        spacing: "block",
                                                    });
                                                    return;
                                                }
                                                for (const item of section.items) {
                                                    replyChildren.push({
                                                        key: sessionRenderItemId(item),
                                                        render: (spacingClassName) =>
                                                            renderItem(item, spacingClassName),
                                                        spacing: replyItemSpacing(item),
                                                    });
                                                }
                                            });
                                            const replyChildCount = replyChildren.length + (copyText === null ? 0 : 1);
                                            return (
                                                <article
                                                    key={group.id}
                                                    aria-label="Agent response"
                                                    className={cn(
                                                        chatSessionAgentReplyGroupClassName,
                                                        replyActive && "pb-3",
                                                    )}
                                                >
                                                    {replyChildren.map((child, index) =>
                                                        child.render(
                                                            replyItemMarginClassName(
                                                                child.spacing,
                                                                index === 0,
                                                                index === replyChildCount - 1,
                                                            ),
                                                        ),
                                                    )}
                                                    {copyText !== null && (
                                                        <ResponseCopyButton
                                                            createStore={createResponseCopyStore}
                                                            text={copyText}
                                                        />
                                                    )}
                                                </article>
                                            );
                                        });
                                    })()}
                                    {presentation.confirmedMessages.map((message) => (
                                        <div key={message.commandId} className={chatSessionMessageItemClassName}>
                                            <UserPromptMessage
                                                attachments={message.attachments}
                                                attachmentLabels={message.attachmentLabels}
                                                text={message.content}
                                            />
                                        </div>
                                    ))}
                                    {presentation.pendingDelivery !== null && (
                                        <div
                                            className={chatSessionMessageItemClassName}
                                            data-testid={dataTestId.queuedMessage}
                                        >
                                            <UserPromptMessage
                                                attachments={presentation.pendingDelivery.message.attachments}
                                                attachmentLabels={presentation.pendingDelivery.message.attachmentLabels}
                                                status={
                                                    presentation.pendingDelivery.error !== null ? (
                                                        <MessageDeliveryStatus
                                                            delivery="failed"
                                                            label="Message failed to send"
                                                        />
                                                    ) : presentation.pendingDelivery.sending ? (
                                                        <MessageDeliveryStatus
                                                            delivery="sending"
                                                            label="Sending message"
                                                        />
                                                    ) : undefined
                                                }
                                                text={presentation.pendingDelivery.message.content}
                                            />
                                            {presentation.pendingDelivery.error !== null && (
                                                <div
                                                    className="ml-auto flex max-w-[85%] items-center gap-3 text-xs text-destructive"
                                                    role="alert"
                                                >
                                                    <span>{presentation.pendingDelivery.error}</span>
                                                    <Button
                                                        disabled={presentation.retryFailedDisabled}
                                                        onClick={() => run(pane.store.getState().retryFailedMessage)}
                                                    >
                                                        Retry message
                                                    </Button>
                                                    <Button
                                                        disabled={attachmentModel.state.kind === "reading"}
                                                        onClick={pane.store.getState().editFailedMessage}
                                                    >
                                                        Edit failed message
                                                    </Button>
                                                    <Button onClick={pane.store.getState().discardFailedMessage}>
                                                        Discard failed message
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {presentation.unconfirmedDelivery !== null && (
                                        <UnconfirmedDeliveryCard
                                            delivery={presentation.unconfirmedDelivery}
                                            retryDisabled={model.connection.kind !== "ready"}
                                            onRemove={() => pane.store.getState().removeUnknownDelivery()}
                                            onRetry={() => run(pane.store.getState().retryUnknownDelivery)}
                                        />
                                    )}
                                    {presentation.workingIndicator !== null &&
                                        presentation.outputState !== "idle" &&
                                        presentation.activity.kind === "working" && (
                                            // mt-1 keeps 4px of air under the previous bubble's reserved
                                            // copy-button strip, matching the consecutive-message rhythm.
                                            <div className="mt-1">
                                                <WorkingIndicator startedAt={presentation.workingIndicator.startedAt} />
                                            </div>
                                        )}
                                    {authenticationRecovery !== null && presentation.authenticationFailure !== null && (
                                        <div className={chatSessionMessageItemClassName}>
                                            <AuthenticationNotice
                                                code={presentation.authenticationFailure.code}
                                                guidance={authenticationRecovery}
                                                message={presentation.authenticationFailure.message}
                                            />
                                        </div>
                                    )}
                                    {welcome.kind === "visible" && model.connection.kind === "ready" && (
                                        <SessionWelcome
                                            canSuggestProgress={presentation.canSuggestProgress}
                                            onDismiss={pane.welcome.getState().dismiss}
                                            onSuggestProgress={pane.welcome.getState().suggestProgress}
                                        />
                                    )}
                                </div>
                            )}
                        </FollowLatestScrollArea>
                        <ChatMessageQueue
                            messages={queuedMessages(model.queued, messageQueue)}
                            steeringSupported={taskControls.steeringSupported}
                            onDelete={(commandId) =>
                                run(async (signal) => await pane.store.getState().deleteQueued(commandId, signal))
                            }
                            onEdit={(commandId) =>
                                run(async (signal) => await pane.store.getState().editQueued(commandId, signal))
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
                                // The card yields the height the header and composer need: it shrinks inside
                                // the clipped pane and keeps scrolling its own content instead of pushing
                                // the composer below the pane's bottom edge.
                                frameClassName={`${chatSessionInteractionColumnClassName} mt-4 mb-2 flex min-h-0 shrink flex-col sm:mt-5`}
                                className="max-h-[min(50vh,360px)] min-h-0 flex-1 overflow-y-auto [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]"
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
                            focusScope={workspace}
                            canAttach={canAddAttachments(attachmentModel)}
                            attachmentSignal={pane.attachmentSignal}
                            disabled={presentation.composerInputDisabled}
                            draft={model.draft}
                            error={presentation.composerError}
                            connectionNotice={
                                executionContext.feedback.kind === "hidden"
                                    ? undefined
                                    : (inline) => (
                                          <ConnectionNotice
                                              feedback={executionContext.feedback}
                                              inline={inline}
                                              onRetryNow={pane.store.getState().retryNow}
                                              onReopen={() => run(pane.store.getState().reopen)}
                                          />
                                      )
                            }
                            statusMessage={
                                executionContext.feedback.kind === "hidden" && model.filesRestoreNotice
                                    ? "Files attached to this message could not be restored here. Add them again if it had any."
                                    : undefined
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
                            stopDisabled={presentation.stopDisabled}
                            submitDisabled={presentation.submitDisabled}
                        >
                            <ChatConfigurationMenu
                                notice={
                                    presentation.settingsNotice === null ? undefined : (
                                        <div className="px-5 pb-3 text-xs leading-5 text-copy-secondary" role="note">
                                            <p>{presentation.settingsNotice}</p>
                                            <button
                                                className="mt-1 rounded-sm text-foreground underline underline-offset-4 outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 disabled:opacity-50"
                                                disabled={presentation.settingsStopDisabled}
                                                onClick={() => run(pane.store.getState().stop)}
                                                type="button"
                                            >
                                                Stop current response
                                            </button>
                                        </div>
                                    )
                                }
                                controls={[
                                    {
                                        disabled: true,
                                        harnessLockedLabel: "The harness cannot be changed for an existing session.",
                                        id: "harness",
                                        kind: "select" as const,
                                        label: "Harness",
                                        locked: true,
                                        onValueChange: () => {},
                                        options: harness.options,
                                        value: harness.value,
                                    },
                                    ...settingsModel.options.map((option) =>
                                        option.type === "boolean"
                                            ? {
                                                  checked: option.booleanValue,
                                                  disabled: presentation.settingsDisabled,
                                                  id: option.id,
                                                  kind: "boolean" as const,
                                                  label: option.name,
                                                  onCheckedChange: () => configure(option, "", !option.booleanValue),
                                                  testId: dataTestId.agentSetting(option.id),
                                              }
                                            : {
                                                  disabled: presentation.settingsDisabled,
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
                                {...(model.operation.kind === "configuring"
                                    ? { loadingControlId: model.operation.configId }
                                    : {})}
                            />
                            {model.operation.kind === "configuring" && (
                                <span role="status" className="sr-only">
                                    Updating agent settings…
                                </span>
                            )}
                        </BotChatComposer>
                    </section>
                    {desktop ? null : (
                        <>
                            {model.titleEdit.kind === "editing" || model.titleEdit.kind === "saving" ? (
                                <MobileRenameOverlay
                                    draft={model.titleEdit.draft}
                                    saving={model.titleEdit.kind === "saving"}
                                    onSetTitleDraft={titleBarProps.onSetTitleDraft}
                                    onCancelTitleEdit={titleBarProps.onCancelTitleEdit}
                                    onConfirmTitleEdit={titleBarProps.onConfirmTitleEdit}
                                />
                            ) : null}
                            <MobileSessionTitlePortal>
                                <div className="flex min-w-0 w-full flex-col items-center">
                                    <SessionConversationTitleBar
                                        {...(model.titleEdit.kind === "editing" || model.titleEdit.kind === "saving"
                                            ? { ...titleBarProps, titleEdit: CLOSED_TITLE_EDIT }
                                            : titleBarProps)}
                                        centered
                                    />
                                    {sessionMessagesLoading ? (
                                        <WorkingDirectorySkeleton className="mt-0.5 h-5 max-w-full" />
                                    ) : (
                                        <ReadonlyWorkingDirectory
                                            className="-mb-1.5 min-h-0 max-w-full gap-1 px-1 py-0 text-[11px] font-normal text-morty-text-3"
                                            clip="end"
                                            directoryLabel={workingDirectoryLabel}
                                            iconClassName="size-3"
                                            tooltipSide="bottom"
                                        />
                                    )}
                                </div>
                            </MobileSessionTitlePortal>
                        </>
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
