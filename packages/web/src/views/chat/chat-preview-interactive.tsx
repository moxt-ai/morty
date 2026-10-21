import {
    Laptop,
    List,
    LoaderCircle,
    MessageSquare,
    RefreshCw,
    Share2,
    SquarePen,
    UserRound,
    Wifi,
    X,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { AgentThinking } from "../../components/chat/agent-thinking.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import { createComposerAttachmentStore } from "../../view-models/chat/composer-attachment-store.ts";
import { SetupCardLogo } from "../setup/setup-card-shell.tsx";
import {
    CHAT_PREVIEW_DRAFT_ID,
    createInitialPreviewSessions,
    groupPreviewSessions,
    type PreviewSession,
    type PreviewSessionStatus,
    previewAssistantReply,
} from "./chat-preview-data.ts";
import { previewAssistantText, previewUserText } from "./chat-preview-session-messages.ts";
import { MobiusAssistantText, MobiusSessionMessage } from "./mobius-session-message.tsx";
import {
    MobiusSessionPaneShell,
    mobiusSessionMessageColumnClassName,
    mobiusSessionMessageItemClassName,
    mobiusSessionMessageScrollClassName,
    sessionRenderItems,
} from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

function createSessionId(): string {
    return `preview-session-${crypto.randomUUID()}`;
}

function createMessageId(): string {
    return `preview-message-${crypto.randomUUID()}`;
}

function PreviewSidebarAction({ children, label }: { readonly children: ReactNode; readonly label: string }) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
            <Tooltip.Portal>
                <MortyTooltipContent side="bottom" sideOffset={6}>
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </MortyTooltipContent>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function PreviewConnectionStatus({ status }: { readonly status: BotConnectionStatus }) {
    const dot =
        status.kind === "connected"
            ? "bg-primary"
            : status.kind === "connecting"
              ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
              : "bg-muted-foreground/60";
    return (
        <div
            className="flex min-h-10 items-center justify-self-end gap-2 px-1.5 py-1.5 sm:mb-6 sm:min-h-0 sm:self-start"
            data-testid={dataTestId.botConnectionStatus}
            data-connection-status={status.kind}
        >
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="hidden min-w-0 flex-1 truncate text-xs font-medium text-foreground sm:block">
                {status.label}
            </span>
            <span className="sr-only sm:hidden">Agent {status.label.toLowerCase()}</span>
        </div>
    );
}

function SessionStatusBadge({ status }: { readonly status: PreviewSessionStatus }) {
    if (status === "working") {
        return (
            <span
                aria-label="Session working"
                className="inline-flex text-primary"
                data-testid={dataTestId.sessionStatus}
                role="status"
            >
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            </span>
        );
    }
    if (status === "failed") {
        return (
            <span
                aria-label="Session failed"
                className="text-xs text-destructive"
                data-testid={dataTestId.sessionStatus}
                role="status"
            >
                Failed
            </span>
        );
    }
    if (status === "unread") {
        return (
            <span
                aria-label="Unread response"
                className="size-2 rounded-full bg-primary"
                data-testid={dataTestId.sessionStatus}
                role="status"
            />
        );
    }
    return null;
}

export function InteractiveChatPreview() {
    const referenceNow = useMemo(() => new Date("2026-10-20T10:30:00+08:00"), []);
    const [sessions, setSessions] = useState(createInitialPreviewSessions);
    const [activeId, setActiveId] = useState<string>("preview-session-message-types");
    const [connectionStatus, setConnectionStatus] = useState<BotConnectionStatus>({
        kind: "unpaired",
        label: "Disconnected",
    });
    const [pairingOpen, setPairingOpen] = useState(false);
    const [nativeSessionsOpen, setNativeSessionsOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [mobileExpanded, setMobileExpanded] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [draft, setDraft] = useState("");
    const [attachmentStore] = useState(() => createComposerAttachmentStore());
    const [attachmentSignal] = useState(() => new AbortController().signal);
    const attachmentModel = useStore(attachmentStore);
    const attachments = attachmentModel.attachments;
    const [composerError, setComposerError] = useState("");
    const [outputState, setOutputState] = useState<"idle" | "sending" | "running" | "stopping">("idle");
    const [disconnectedNoticeDismissed, setDisconnectedNoticeDismissed] = useState(false);
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const replyTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

    const connected = connectionStatus.kind === "connected";
    const isDraft = activeId === CHAT_PREVIEW_DRAFT_ID;
    const activeSession = isDraft ? null : (sessions.find((item) => item.id === activeId) ?? null);
    const sessionGroups = useMemo(() => groupPreviewSessions(sessions, referenceNow), [referenceNow, sessions]);

    useEffect(
        () => () => {
            if (replyTimer.current !== null) {
                clearTimeout(replyTimer.current);
            }
        },
        [],
    );

    const connectAgent = () => {
        setPairingOpen(true);
    };

    const finishConnect = () => {
        setPairingOpen(false);
        setConnectionStatus({ kind: "connected", label: "Connected" });
        setDisconnectedNoticeDismissed(false);
    };

    const disconnectAgent = () => {
        setConnectionStatus({ kind: "disconnected", label: "Disconnected" });
        setActiveId(CHAT_PREVIEW_DRAFT_ID);
    };

    const refreshSessions = () => {
        if (refreshing) {
            return;
        }
        setRefreshing(true);
        setConnectionStatus({ kind: "connecting", label: "Connecting" });
        window.setTimeout(() => {
            setRefreshing(false);
            setConnectionStatus(
                connected ? { kind: "connected", label: "Connected" } : { kind: "unpaired", label: "Disconnected" },
            );
        }, 900);
    };

    const newConversation = () => {
        setActiveId(CHAT_PREVIEW_DRAFT_ID);
        setDraft("");
        attachmentStore.getState().clear();
        setComposerError("");
        setMobileExpanded(false);
    };

    const openSession = (id: string) => {
        if (!connected) {
            return;
        }
        setActiveId(id);
        setComposerError("");
        setMobileExpanded(false);
        setSessions((current) =>
            current.map((item) => (item.id === id && item.status === "unread" ? { ...item, status: "idle" } : item)),
        );
    };

    const archiveSession = (id: string) => {
        setSessions((current) => current.filter((item) => item.id !== id));
        if (activeId === id) {
            setActiveId(CHAT_PREVIEW_DRAFT_ID);
        }
    };

    const updateSession = (id: string, update: (session: PreviewSession) => PreviewSession) => {
        setSessions((current) => current.map((item) => (item.id === id ? update(item) : item)));
    };

    const sendMessage = () => {
        if (!connected || outputState !== "idle") {
            return;
        }
        const text = draft.trim();
        if (text.length === 0 && attachments.length === 0) {
            return;
        }
        if (attachments.length > 0) {
            setComposerError("Attachment styling preview is not wired yet; send text only.");
            return;
        }
        setComposerError("");
        setOutputState("sending");

        const now = new Date(referenceNow);
        let targetSessionId = activeId;
        if (isDraft) {
            targetSessionId = createSessionId();
        }
        const userMessage = previewUserText(createMessageId(), targetSessionId, text);

        if (isDraft) {
            const title = text.length > 48 ? `${text.slice(0, 48)}…` : text;
            setSessions((current) => [
                {
                    id: targetSessionId,
                    title: title.length > 0 ? title : "New session",
                    directoryLabel: "~/morty",
                    updatedAt: now,
                    status: "working",
                    messages: [userMessage],
                },
                ...current,
            ]);
            setActiveId(targetSessionId);
        } else {
            updateSession(targetSessionId, (session) => ({
                ...session,
                updatedAt: now,
                status: "working",
                messages: [...session.messages, userMessage],
            }));
        }

        setDraft("");
        attachmentStore.getState().clear();
        setOutputState("running");

        const replySessionId = targetSessionId;
        replyTimer.current = globalThis.setTimeout(() => {
            updateSession(replySessionId, (session) => ({
                ...session,
                status: "idle",
                messages: [
                    ...session.messages,
                    previewAssistantText(createMessageId(), replySessionId, previewAssistantReply(text)),
                ],
            }));
            setOutputState("idle");
            replyTimer.current = null;
        }, 1200);
    };

    const showComposer = connected;
    const showLanding = isDraft || activeSession === null;
    const showDisconnectedNotice =
        connected === false && connectionStatus.kind === "disconnected" && disconnectedNoticeDismissed === false;

    return (
        <>
            <main
                aria-label="Chat preview"
                className="fixed inset-0 flex min-h-0 overflow-hidden bg-sidebar text-foreground max-sm:flex-col sm:flex-row"
            >
                <aside
                    aria-label="Morty navigation"
                    className="grid min-h-0 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-y-2 overflow-hidden border-b border-border/80 bg-sidebar px-3 py-3 sm:flex sm:w-[280px] sm:flex-col sm:gap-0 sm:border-r sm:border-b-0 sm:px-3.5 sm:py-4"
                >
                    <div className="col-start-1 row-start-1 flex items-center gap-3 px-1.5 sm:col-auto sm:row-auto sm:mb-3">
                        <span
                            aria-hidden="true"
                            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-[0_4px_12px_rgba(47,184,114,0.18)]"
                        >
                            M
                        </span>
                        <span className="hidden min-w-0 sm:block">
                            <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Morty</h1>
                        </span>
                    </div>
                    <PreviewConnectionStatus status={connectionStatus} />
                    <div className="col-start-1 row-start-2 flex min-w-0 items-center justify-between px-1 sm:col-auto sm:row-auto sm:mb-2">
                        <h2 className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">
                            Recent sessions
                        </h2>
                        <Button
                            variant="ghost"
                            className="size-10 shrink-0 justify-center rounded-lg px-0 sm:hidden"
                            aria-label="Recent sessions"
                            aria-expanded={mobileExpanded}
                            aria-controls="chat-conversations"
                            type="button"
                            onClick={() => setMobileExpanded((value) => !value)}
                        >
                            <List aria-hidden="true" className="size-5" />
                        </Button>
                        <Tooltip.Provider delayDuration={150}>
                            <div className="flex items-center gap-0.5">
                                <PreviewSidebarAction label="New Session">
                                    <Button
                                        aria-label="New Session"
                                        className="size-8 rounded-lg"
                                        data-testid={dataTestId.newConversation}
                                        disabled={!connected}
                                        onClick={newConversation}
                                        size="icon"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <SquarePen aria-hidden="true" className="size-3.5" />
                                    </Button>
                                </PreviewSidebarAction>
                                <PreviewSidebarAction label="Open Session">
                                    <Button
                                        aria-label="Open Session"
                                        className="size-8 rounded-lg"
                                        disabled={!connected}
                                        onClick={() => setNativeSessionsOpen(true)}
                                        size="icon"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <Laptop aria-hidden="true" className="size-3.5" />
                                    </Button>
                                </PreviewSidebarAction>
                                <PreviewSidebarAction label={refreshing ? "Refreshing sessions" : "Refresh sessions"}>
                                    <Button
                                        aria-busy={refreshing}
                                        aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                        className="size-8 rounded-lg"
                                        disabled={refreshing}
                                        onClick={refreshSessions}
                                        size="icon"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <RefreshCw
                                            className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                        />
                                    </Button>
                                </PreviewSidebarAction>
                            </div>
                        </Tooltip.Provider>
                    </div>
                    <div
                        id="chat-conversations"
                        className={`${mobileExpanded ? "block" : "hidden"} col-span-2 row-start-3 max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 sm:col-auto sm:row-auto sm:block sm:max-h-none`}
                    >
                        {refreshing && (
                            <div
                                aria-label="Loading sessions"
                                className="space-y-1 animate-pulse motion-reduce:animate-none"
                                role="status"
                            >
                                <span className="sr-only">Loading sessions…</span>
                                <div aria-hidden="true" className="px-[12px] py-2.5">
                                    <div className="h-3.5 w-3/4 rounded-full bg-border" />
                                </div>
                                <div aria-hidden="true" className="px-[12px] py-2.5">
                                    <div className="h-3.5 w-1/2 rounded-full bg-border" />
                                </div>
                            </div>
                        )}
                        {!refreshing && !connected && (
                            <div
                                className="mx-1 flex flex-col items-center rounded-xl border border-border/70 bg-white/55 px-4 py-5 text-center shadow-[0_1px_3px_rgba(17,24,20,0.04)]"
                                data-testid={dataTestId.conversationSetupRequired}
                            >
                                <span className="mb-2 flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                                    <MessageSquare aria-hidden="true" className="size-4" />
                                </span>
                                <p className="text-sm font-medium text-foreground">No sessions yet</p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    Connect your local agent to start chatting.
                                </p>
                                <Button
                                    className="mt-3"
                                    onClick={connectAgent}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    Connect agent
                                </Button>
                            </div>
                        )}
                        {!refreshing &&
                            connected &&
                            sessionGroups.map((group) => (
                                <section className="space-y-1" key={group.label}>
                                    <h3 className="px-[12px] pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
                                        {group.label}
                                    </h3>
                                    {group.sessions.map((session) => (
                                        <div className="group/session relative" key={session.id}>
                                            <button
                                                data-testid={dataTestId.managedConversation}
                                                type="button"
                                                aria-current={activeId === session.id ? "page" : undefined}
                                                onClick={() => openSession(session.id)}
                                                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-[12px] py-2.5 pr-10 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 aria-[current=page]:bg-white aria-[current=page]:text-foreground motion-reduce:transition-none"
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate">{session.title}</span>
                                                    <span className="block truncate text-[11px] leading-4 font-normal text-copy-secondary">
                                                        {session.directoryLabel}
                                                    </span>
                                                </span>
                                                <SessionStatusBadge status={session.status} />
                                            </button>
                                            <button
                                                aria-label={`Archive ${session.title}`}
                                                className="absolute top-2 right-2 hidden size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted group-hover/session:flex"
                                                onClick={() => archiveSession(session.id)}
                                                type="button"
                                            >
                                                <X aria-hidden="true" className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </section>
                            ))}
                    </div>
                    <div className="col-span-2 row-start-4 mt-auto hidden shrink-0 items-center justify-between gap-1 border-t border-border/70 pt-3 sm:col-auto sm:row-auto sm:flex">
                        <Button
                            aria-label={connected ? "Disconnect agent (preview)" : "Connect agent (preview)"}
                            className="size-9 rounded-lg"
                            onClick={() => (connected ? disconnectAgent() : connectAgent())}
                            size="icon"
                            type="button"
                            variant="ghost"
                        >
                            <Wifi aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                            aria-label="Account"
                            className="size-9 rounded-lg"
                            size="icon"
                            type="button"
                            variant="ghost"
                        >
                            <UserRound aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                            aria-label="Share Morty"
                            className="size-9 rounded-lg"
                            onClick={() => setShareOpen(true)}
                            size="icon"
                            type="button"
                            variant="ghost"
                        >
                            <Share2 aria-hidden="true" className="size-4" />
                        </Button>
                    </div>
                </aside>

                <MobiusSessionPaneShell
                    footer={
                        showComposer ? (
                            <BotChatComposer
                                attachmentModel={attachmentModel}
                                attachmentSignal={attachmentSignal}
                                disabled={outputState !== "idle"}
                                draft={draft}
                                error={composerError}
                                onDraftChange={setDraft}
                                onStop={() => setOutputState("idle")}
                                onSubmit={sendMessage}
                                outputState={outputState}
                                submitDisabled={
                                    outputState !== "idle" || (draft.trim().length === 0 && attachments.length === 0)
                                }
                            >
                                <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[13px] text-muted-foreground">
                                    <button
                                        className="rounded-lg border border-border bg-background px-2.5 py-1.5"
                                        type="button"
                                    >
                                        Agent · Codex
                                    </button>
                                    <button
                                        className="rounded-lg border border-border bg-background px-2.5 py-1.5"
                                        type="button"
                                    >
                                        ~/morty
                                    </button>
                                </div>
                            </BotChatComposer>
                        ) : undefined
                    }
                    title={activeSession?.title ?? (isDraft ? "New session" : "Untitled session")}
                >
                    <FollowLatestScrollArea
                        aria-label="Messages"
                        className={mobiusSessionMessageScrollClassName}
                        container={messageListRef}
                        followRevision={null}
                        followThreshold={80}
                        role="log"
                        showTopFade
                    >
                        <div className={`${mobiusSessionMessageColumnClassName} flex min-h-full flex-col`}>
                            {connectionStatus.kind === "connecting" && (
                                <div
                                    className="m-auto w-full max-w-lg px-6 text-center"
                                    data-testid={dataTestId.chatLanding}
                                >
                                    <div className="mx-auto w-fit [&>div]:mb-5">
                                        <SetupCardLogo />
                                    </div>
                                    <p className="mb-2 text-13 font-medium tracking-[0.06em] text-primary uppercase">
                                        Connecting to agent
                                    </p>
                                    <h1 className="text-32 font-semibold tracking-[-0.035em]">Morty</h1>
                                    <p className="mx-auto mt-3 max-w-sm text-16 leading-[26px] text-muted-foreground">
                                        Chat is restoring access to this session.
                                    </p>
                                </div>
                            )}
                            {connectionStatus.kind !== "connecting" && showLanding && (
                                <div
                                    className="m-auto w-full max-w-lg px-6 text-center"
                                    data-testid={dataTestId.chatLanding}
                                >
                                    <div className="mx-auto w-fit [&>div]:mb-5">
                                        <SetupCardLogo />
                                    </div>
                                    <p className="mb-2 text-13 font-medium tracking-[0.06em] text-primary uppercase">
                                        Ready to collaborate
                                    </p>
                                    <h1 className="text-32 font-semibold tracking-[-0.035em]">Morty</h1>
                                    <p className="mx-auto mt-3 max-w-sm text-16 leading-[26px] text-muted-foreground">
                                        Ask a question, explore your project, or start a task with your local agent.
                                    </p>
                                </div>
                            )}
                            {connectionStatus.kind !== "connecting" && activeSession !== null && (
                                <>
                                    {activeSession.messages.length === 0 && (
                                        <p className="text-center text-sm text-muted-foreground">
                                            Empty session — send a message to fill this thread.
                                        </p>
                                    )}
                                    {sessionRenderItems(activeSession.messages).map((item, index, items) => (
                                        <div
                                            className={mobiusSessionMessageItemClassName}
                                            key={item.kind === "event" ? item.message.firstEvent.eventId : item.id}
                                        >
                                            {item.kind === "assistant-text" ? (
                                                <MobiusAssistantText
                                                    openLocalFile={() => {}}
                                                    streaming={false}
                                                    text={item.text}
                                                />
                                            ) : item.kind === "thinking" ? (
                                                <div data-testid={dataTestId.agentResponse}>
                                                    <AgentThinking
                                                        active={outputState === "running" && index === items.length - 1}
                                                        entries={item.entries}
                                                    />
                                                </div>
                                            ) : (
                                                <MobiusSessionMessage
                                                    active={outputState === "running" && index === items.length - 1}
                                                    deliveryUnknownUserMessageId={null}
                                                    failureApproval={{ kind: "unavailable" }}
                                                    message={item.message}
                                                    onRemoveUnknownDelivery={() => {}}
                                                    onRetryUnknownDelivery={() => {}}
                                                    openLocalFile={() => {}}
                                                />
                                            )}
                                        </div>
                                    ))}
                                    {outputState === "running" && (
                                        <div className={mobiusSessionMessageItemClassName}>
                                            <MobiusAssistantText
                                                openLocalFile={() => {}}
                                                streaming
                                                text="Thinking through your preview request…"
                                            />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </FollowLatestScrollArea>
                </MobiusSessionPaneShell>
            </main>

            {pairingOpen && (
                <Dialog
                    appearance="setup"
                    description="Copy this instruction into your agent. It will connect itself and finish the setup for you."
                    onClose={() => setPairingOpen(false)}
                    title="Connect your local agent"
                >
                    <PairingInstruction />
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <Button onClick={() => setPairingOpen(false)} type="button" variant="outline">
                            Cancel
                        </Button>
                        <Button onClick={finishConnect} type="button">
                            Mark connected (preview)
                        </Button>
                    </div>
                </Dialog>
            )}

            {nativeSessionsOpen && (
                <Dialog
                    description="Preview placeholder for the native session picker dialog."
                    onClose={() => setNativeSessionsOpen(false)}
                    title="Open Session"
                >
                    <ul className="grid gap-2 text-sm">
                        <li className="rounded-lg border border-border px-3 py-2">Import Cursor session · 2h ago</li>
                        <li className="rounded-lg border border-border px-3 py-2">
                            Fork Claude Code session · Yesterday
                        </li>
                    </ul>
                    <Button className="mt-4" onClick={() => setNativeSessionsOpen(false)} type="button">
                        Close
                    </Button>
                </Dialog>
            )}

            {shareOpen && (
                <Dialog
                    description="Preview placeholder for identity sharing."
                    onClose={() => setShareOpen(false)}
                    title="Share Morty"
                >
                    <p className="text-sm text-muted-foreground">Handoff link and QR styling can be tuned here.</p>
                    <Button className="mt-4" onClick={() => setShareOpen(false)} type="button">
                        Close
                    </Button>
                </Dialog>
            )}

            {showDisconnectedNotice && (
                <div
                    aria-live="polite"
                    className="fixed top-4 right-4 z-[100] grid w-[calc(100%-2rem)] max-w-sm grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg sm:top-6 sm:right-6"
                    role="status"
                >
                    <div className="min-w-0">
                        <p className="font-medium">Agent disconnected</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Preview mode simulated a runtime disconnect. Connect again to keep editing composer styles.
                        </p>
                    </div>
                    <button
                        aria-label="Dismiss disconnected agent notification"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                        onClick={() => setDisconnectedNoticeDismissed(true)}
                        type="button"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            )}
        </>
    );
}
