import {
    Laptop,
    List,
    LoaderCircle,
    LogOut,
    type LucideIcon,
    MessageSquare,
    MessageSquarePlus,
    RefreshCw,
    Share2,
    Wifi,
    X,
} from "lucide-react";
import { ContextMenu, Tooltip } from "radix-ui";
import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { MortyLogoMark } from "../../components/brand/morty-logo.tsx";
import { mobileHeaderIconButtonClassName } from "../../components/chat/chat-header-control.ts";
import { mortyThinScrollbarClassName } from "../../components/chat/chat-session-layout.ts";
import { ComputerOfflineIcon } from "../../components/chat/computer-offline-icon.tsx";
import { PanelPresence } from "../../components/chat/panel-presence.tsx";
import { panelMotionClassName } from "../../components/chat/sidebar-panel-presence.ts";
import { SidebarUserMenu } from "../../components/chat/sidebar-user-menu.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { type OverlayContentOpenAutoFocus, preventOverlayOpenAutoFocus } from "../../components/ui/overlay-surface.ts";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import { chatDiagnostics } from "../../view-models/chat/chat-diagnostics.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import {
    type ConversationDirectoryStore,
    conversationDirectorySessions,
} from "../../view-models/chat/conversation-directory-store.ts";
import { type ConversationGroup, groupConversationsByUpdatedAt } from "../../view-models/chat/conversation-groups.ts";
import {
    type ConversationListStatus,
    conversationListStatus,
} from "../../view-models/chat/conversation-status-store.ts";
import { pendingExecutionContext, sessionExecutionContext } from "../../view-models/chat/execution-context.ts";
import { nativeSessionAgentTabs } from "../../view-models/chat/native-session-agents.ts";
import { projectLocationLabel } from "../../view-models/chat/project-location-label.ts";
import { noSessionDelivery } from "../../view-models/chat/session-delivery-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import {
    ComputerSwitcher,
    mobileDrawerCardClassName,
    mobileDrawerCardRowClassName,
    mobileDrawerOptionDividerClassName,
} from "./computer-switcher.tsx";
import { IdentitySharing } from "./identity-sharing.tsx";
import { NativeSessionDialog } from "./native-session-dialog.tsx";

/** Releases pointer-click focus so the action's tooltip and focus ring do not linger. */
function blurAfterPointerClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.detail > 0) {
        event.currentTarget.blur();
    }
}

function SidebarSessionOption({
    label,
    icon: Icon,
    onClick,
    testId,
    disabled = false,
    variant = "nav",
}: {
    readonly label: string;
    readonly icon: LucideIcon;
    readonly onClick: () => void;
    readonly testId?: string;
    readonly disabled?: boolean;
    readonly variant?: "nav" | "card";
}) {
    return (
        <button
            type="button"
            className={
                variant === "card"
                    ? mobileDrawerCardRowClassName
                    : "flex w-full items-center gap-3 rounded-lg px-3.5 py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 active:bg-morty-fill-opacity-3 active:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-copy-secondary disabled:active:text-copy-secondary motion-reduce:transition-none"
            }
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon
                aria-hidden="true"
                className={variant === "card" ? "size-5 shrink-0 text-copy-secondary" : "size-4 shrink-0"}
            />
            {label}
        </button>
    );
}

function SidebarActionTooltip({
    children,
    label,
    side = "bottom",
}: {
    readonly children: ReactNode;
    readonly label: string;
    readonly side?: "top" | "bottom";
}) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
            <Tooltip.Portal>
                <MortyTooltipContent side={side} sideOffset={6}>
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </MortyTooltipContent>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function ManagedSessionDirectoryList({
    directory,
    archive,
    sessions,
    conversationGroups,
    activeId,
    connectionStatus,
    sessionStatuses,
    openPane,
    onConnectAgent,
    onOpen,
    archiveSession,
    operationsSignal,
}: {
    readonly directory: ConversationDirectoryStore["state"];
    readonly archive: ConversationDirectoryStore["archive"];
    readonly sessions: readonly ManagedChatSession[] | null;
    readonly conversationGroups: readonly ConversationGroup[] | null;
    readonly activeId: string;
    readonly connectionStatus: BotConnectionStatus;
    readonly sessionStatuses: ReadonlyMap<string, ConversationListStatus>;
    /** The open Session's pane, whose turn and delivery decide that Session's status. */
    readonly openPane: Parameters<typeof conversationListStatus>[2];
    readonly onConnectAgent: (() => void) | null;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly archiveSession: ConversationDirectoryStore["archiveSession"];
    readonly operationsSignal: () => AbortSignal;
}) {
    return (
        <Tooltip.Provider delayDuration={150}>
            {(directory.kind === "failed" || directory.kind === "stale") &&
                (directory.failure === "connection" ? (
                    <div
                        role="status"
                        className="flex flex-col items-start gap-2 px-2 py-3 text-xs text-muted-foreground"
                    >
                        <ComputerOfflineIcon />
                        <p>{directory.message}</p>
                    </div>
                ) : (
                    <MortyAlert>{directory.message}</MortyAlert>
                ))}
            {directory.kind === "setup-required" && (
                <div
                    className="flex flex-col items-center rounded-xl border border-border/70 bg-white/55 px-4 py-5 text-center shadow-[0_1px_3px_rgba(17,24,20,0.04)]"
                    data-testid={dataTestId.conversationSetupRequired}
                >
                    <span className="mb-2 flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <MessageSquare aria-hidden="true" className="size-4" />
                    </span>
                    <p className="text-sm font-medium text-foreground">No sessions yet</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Connect your local agent to start chatting.
                    </p>
                    {onConnectAgent !== null && (
                        <Button className="mt-3" onClick={onConnectAgent} size="sm" variant="outline">
                            Connect agent
                        </Button>
                    )}
                </div>
            )}
            {archive.kind === "failed" && <MortyAlert>{archive.message}</MortyAlert>}
            {archive.kind === "unconfirmed" && (
                <MortyAlert tone="warning">
                    Removed from the list, but stopping the session could not be confirmed. The agent may still be
                    running on your computer.
                </MortyAlert>
            )}
            {sessions !== null && sessions.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground sm:py-2">Your Chat sessions will appear here.</p>
            )}
            {conversationGroups?.map((group) => (
                <section className="mb-3 min-w-0 w-full space-y-0 last:mb-0" key={group.label}>
                    <h3 className="sticky top-0 z-[1] -mx-2 mb-0 bg-card px-[22px] pb-1 pt-1 text-13 font-normal text-morty-text-3 sm:-mx-2.5 sm:bg-sidebar sm:px-6 sm:text-11">
                        {group.label}
                    </h3>
                    {group.sessions.map((session) => {
                        const status = conversationListStatus(session, sessionStatuses, openPane);
                        const sessionButton = (
                            <button
                                data-testid={dataTestId.managedConversation}
                                type="button"
                                aria-label={`Open ${session.title}`}
                                aria-current={activeId === session.id ? "page" : undefined}
                                disabled={connectionStatus.kind !== "connected"}
                                onClick={() => onOpen(session)}
                                className="box-border mb-0 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[20px] px-4 py-2 text-left text-15 font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-copy-secondary aria-[current=page]:bg-morty-fill-opacity-3 aria-[current=page]:text-foreground aria-[current=page]:hover:bg-morty-fill-opacity-4 aria-[current=page]:hover:text-foreground aria-[current=page]:disabled:hover:text-foreground motion-reduce:transition-none sm:h-9 sm:px-3.5 sm:py-0 sm:text-13"
                            >
                                <span className="min-w-0 truncate">{session.title}</span>
                                {status.kind === "working" ? (
                                    <span
                                        aria-label="Session working"
                                        className="inline-flex -mr-0.5 text-copy-secondary"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-3 animate-spin motion-reduce:animate-none"
                                        />
                                    </span>
                                ) : status.kind === "failed" ? (
                                    <span
                                        aria-label="Session failed"
                                        className="text-xs text-destructive"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        Failed
                                    </span>
                                ) : status.kind === "unread" ? (
                                    <span
                                        aria-label="Unread response"
                                        className="inline-flex -mr-[3px] size-4 items-center justify-center"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        <span className="size-2 rounded-full bg-primary" />
                                    </span>
                                ) : null}
                            </button>
                        );
                        const sessionTrigger =
                            session.directoryLabel.length > 0 ? (
                                <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                        <ContextMenu.Trigger asChild>{sessionButton}</ContextMenu.Trigger>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                        <MortyTooltipContent className="max-w-xs leading-5" side="right" sideOffset={8}>
                                            <div className="grid gap-1">
                                                <span className="font-medium break-words">{session.title}</span>
                                                <span className="break-all text-background/80">
                                                    {session.directoryLabel}
                                                </span>
                                            </div>
                                            <Tooltip.Arrow className="fill-foreground" />
                                        </MortyTooltipContent>
                                    </Tooltip.Portal>
                                </Tooltip.Root>
                            ) : (
                                <ContextMenu.Trigger asChild>{sessionButton}</ContextMenu.Trigger>
                            );
                        return (
                            <div className="min-w-0 w-full" key={session.id}>
                                <ContextMenu.Root>
                                    {sessionTrigger}
                                    <ContextMenu.Portal>
                                        <ContextMenu.Content
                                            className="z-[110] min-w-40 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg"
                                            {...({
                                                onOpenAutoFocus: preventOverlayOpenAutoFocus,
                                            } satisfies OverlayContentOpenAutoFocus)}
                                        >
                                            <ContextMenu.Item
                                                className="cursor-pointer rounded-md px-3 py-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                                                data-testid={dataTestId.archiveConversation}
                                                disabled={archive.kind === "archiving"}
                                                onSelect={() => {
                                                    void archiveSession(session.id, operationsSignal());
                                                }}
                                            >
                                                Close session
                                            </ContextMenu.Item>
                                        </ContextMenu.Content>
                                    </ContextMenu.Portal>
                                </ContextMenu.Root>
                            </div>
                        );
                    })}
                </section>
            ))}
        </Tooltip.Provider>
    );
}

function ConnectionStatus({
    status,
    className,
    testId,
}: {
    readonly status: BotConnectionStatus;
    readonly className?: string;
    readonly testId?: string;
}) {
    const dot =
        status.kind === "connected"
            ? "bg-success"
            : status.kind === "connecting"
              ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
              : "bg-muted-foreground/60";
    return (
        <div
            className={cn("flex shrink-0 items-center gap-2 py-0.5", className)}
            data-testid={testId}
            data-connection-status={status.kind}
        >
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0 truncate text-xs font-normal text-morty-text-3">{status.label}</span>
        </div>
    );
}

export function ConversationSidebar({
    botId,
    connectionStatus,
    workspace,
    onConnectAgent,
    requests,
    activeId,
    onOpen,
    onNewConversation,
}: {
    readonly botId: string;
    readonly connectionStatus: BotConnectionStatus;
    readonly workspace: ChatWorkspace;
    readonly onConnectAgent: (() => void) | null;
    readonly requests: Pick<
        BotChatApi,
        | "archiveManagedSession"
        | "runtimeConfiguration"
        | "nativeSessions"
        | "nativeSession"
        | "managedSessions"
        | "daemonDiagnostics"
        | "networkDiagnostic"
    >;
    readonly activeId: string;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onNewConversation: () => void;
}) {
    // The workspace owns the sidebar's dialog, remote-access, and diagnostic
    // stores outside React; the view only subscribes.
    const dialogs = workspace.sidebar.dialogs;
    const home = useStore(workspace.home);
    const draftSettings = useStore(workspace.draftControls, (state) => state.settings);
    const pane = workspace.sessionPane();
    const paneSource = useStore(pane?.store ?? workspace.home);
    const paneDelivery = useStore(pane?.delivery ?? noSessionDelivery, (state) => state.state);
    const executionContext =
        home.selection.kind === "ready" && pane !== null && "connection" in paneSource
            ? sessionExecutionContext(pane.session, home, paneSource.connection)
            : pendingExecutionContext(home, draftSettings);
    const runtime = home.runtimeConfiguration?.runtime ?? null;
    const computerName = runtime?.machineName ?? "";
    const nativeAgents = runtime === null ? [] : nativeSessionAgentTabs(runtime);
    const directory = useStore(workspace.directory, (state) => state.state);
    const archive = useStore(workspace.directory, (state) => state.archive);
    const titles = useStore(workspace.titles, (state) => state.titles);
    const calendarDay = useStore(workspace.directory, (state) => state.calendarDay);

    const sessionStatuses = useStore(workspace.statuses, (state) => state.statuses);
    const dialogState = useStore(dialogs);
    const mobileNavOpen = dialogState.mobileNavOpen;
    const mobileSessionsOpen = dialogState.mobileSessionsOpen;
    const dialogStore = dialogState.nativeDialog;
    const sharingStore = dialogState.sharing;
    const openMobileRecentSessions = dialogs.getState().openMobileRecentSessions;
    const closeMobileRecentSessions = dialogs.getState().closeMobileRecentSessions;
    const access = useStore(workspace.sidebar.remoteAccess);
    const diagnostic = useStore(workspace.sidebar.networkDiagnostic);
    const sessionDiagnostics = {
        botId,
        sessionId: activeId,
        nativeSessionId: null,
        context: () => chatDiagnostics(workspace),
        read: (signal: AbortSignal) => requests.daemonDiagnostics(botId, signal),
        readNetwork: (signal: AbortSignal) => requests.networkDiagnostic(botId, signal),
    };
    const measureNetwork = () => {
        void diagnostic.measure(workspace.operationsSignal()).catch(() => undefined);
    };
    const sessions = conversationDirectorySessions(directory, titles);
    const conversationGroups = sessions === null ? null : groupConversationsByUpdatedAt(sessions, calendarDay);
    const refreshing = directory.kind === "refreshing";
    const openSession = (session: ManagedChatSession) => {
        onOpen(session);
        dialogs.getState().closeMobileNav();
        dialogs.getState().closeMobileRecentSessions();
    };
    const sessionListProps = {
        directory,
        archive,
        sessions,
        conversationGroups,
        activeId,
        connectionStatus,
        sessionStatuses,
        openPane:
            home.selection.kind === "ready" && pane !== null && "turn" in paneSource
                ? { sessionId: pane.session.result.ready.sessionId, pane: paneSource, delivery: paneDelivery }
                : null,
        onConnectAgent,
        onOpen: openSession,
        archiveSession: workspace.directory.getState().archiveSession,
        operationsSignal: workspace.operationsSignal,
    };
    return (
        <DesktopChatLayout>
            {(desktop) => (
                <PanelPresence open={mobileNavOpen}>
                    {(navigationMotion) => (
                        <PanelPresence open={mobileSessionsOpen}>
                            {(sessionsMotion) => (
                                <>
                                    {/* Desktop isolate keeps sticky group labels under the session pane shadow. */}
                                    <aside
                                        ref={dialogs.getState().onAttach}
                                        id="conversation-sidebar-mobile-panel"
                                        aria-label="Morty navigation"
                                        className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden bg-card/90 px-3 pt-0 max-sm:overflow-visible sm:isolate sm:w-[264px] sm:gap-0 sm:bg-sidebar sm:px-2.5 sm:pt-2 sm:pb-4"
                                    >
                                        <header className="relative flex min-w-0 shrink-0 items-center justify-between gap-4 py-0 max-sm:z-[110] max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:bg-card/90 max-sm:py-2 sm:gap-3">
                                            <div
                                                className={cn(
                                                    "relative z-[1] flex w-fit shrink-0 items-center gap-2 sm:w-full sm:pl-1",
                                                    desktop &&
                                                        workspace.computers !== null &&
                                                        // The computer switcher bleeds left with a negative margin; this keeps its
                                                        // mark on the same 16px optical gutter the sidebar had before the
                                                        // outer padding tightened to 10px.
                                                        "sm:min-w-0 sm:shrink sm:pl-0.5",
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    aria-controls="conversation-sidebar-mobile-drawer"
                                                    aria-expanded={mobileNavOpen}
                                                    aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
                                                    className={cn(
                                                        "inline-flex items-center justify-center outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 sm:hidden",
                                                        mobileHeaderIconButtonClassName,
                                                    )}
                                                    onClick={() => {
                                                        if (mobileNavOpen) {
                                                            dialogs.getState().closeMobileNav();
                                                        } else {
                                                            dialogs.getState().openMobileNav();
                                                            if (workspace.computers !== null) {
                                                                void workspace.computers.refresh();
                                                            }
                                                        }
                                                        dialogs.getState().closeMobileRecentSessions();
                                                    }}
                                                >
                                                    <MortyLogoMark size={24} />
                                                </button>
                                                {desktop && workspace.computers !== null ? (
                                                    <>
                                                        <h1 className="sr-only">Morty</h1>
                                                        {/* The computer scopes everything in the sidebar, so it heads it. */}
                                                        <ComputerSwitcher
                                                            context={executionContext}
                                                            layout="header"
                                                            model={workspace.computers}
                                                            name={computerName}
                                                            status={connectionStatus}
                                                        />
                                                    </>
                                                ) : (
                                                    <>
                                                        <MortyLogoMark className="hidden sm:block" size={28} />
                                                        <span className="hidden min-w-0 sm:block">
                                                            <h1 className="truncate font-inter text-16 leading-5 font-semibold tracking-[-0.015em] text-foreground/90">
                                                                Morty
                                                            </h1>
                                                        </span>
                                                    </>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    className={cn(mobileHeaderIconButtonClassName, "sm:hidden")}
                                                    aria-label="Recent sessions"
                                                    aria-expanded={mobileSessionsOpen}
                                                    aria-controls="chat-conversations-mobile-sheet"
                                                    onClick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        if (mobileSessionsOpen) {
                                                            closeMobileRecentSessions();
                                                            return;
                                                        }
                                                        openMobileRecentSessions();
                                                    }}
                                                >
                                                    <List aria-hidden="true" className="size-5" />
                                                </Button>
                                            </div>
                                            <div
                                                id={dataTestId.mobileSessionTitleSlot}
                                                className="pointer-events-none flex min-w-0 flex-1 items-center justify-center overflow-visible sm:hidden"
                                            />
                                            <div
                                                className={cn(
                                                    "flex min-w-0 shrink items-center justify-end gap-0.5",
                                                    workspace.computers !== null && "sm:hidden",
                                                )}
                                            >
                                                <Tooltip.Provider delayDuration={150}>
                                                    {!desktop && (
                                                        <div className="flex items-center gap-2 sm:hidden">
                                                            <SidebarActionTooltip label="New Session">
                                                                <Button
                                                                    aria-label="New Session"
                                                                    className={mobileHeaderIconButtonClassName}
                                                                    data-testid={dataTestId.newConversation}
                                                                    onClick={onNewConversation}
                                                                    size="icon"
                                                                    variant="ghost"
                                                                >
                                                                    <MessageSquarePlus
                                                                        aria-hidden="true"
                                                                        className="size-5"
                                                                    />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                            <SidebarActionTooltip label="Open Session">
                                                                <Button
                                                                    aria-label="Open Session"
                                                                    className={mobileHeaderIconButtonClassName}
                                                                    onClick={dialogs.getState().openNativeDialog}
                                                                    size="icon"
                                                                    variant="ghost"
                                                                >
                                                                    <Laptop aria-hidden="true" className="size-5" />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                        </div>
                                                    )}
                                                </Tooltip.Provider>
                                                {workspace.computers === null && (
                                                    <ConnectionStatus
                                                        className="max-sm:hidden pr-[10px]"
                                                        status={connectionStatus}
                                                        testId={dataTestId.botConnectionStatus}
                                                    />
                                                )}
                                            </div>
                                        </header>
                                        {navigationMotion.present ? (
                                            <button
                                                type="button"
                                                aria-label="Close navigation"
                                                className={cn(
                                                    "fixed inset-0 z-[130] bg-black/30 sm:hidden",
                                                    navigationMotion.animate && panelMotionClassName,
                                                    navigationMotion.shown ? "opacity-100" : "opacity-0",
                                                )}
                                                onClick={dialogs.getState().closeMobileNav}
                                            />
                                        ) : null}
                                        <div
                                            id="conversation-sidebar-mobile-drawer"
                                            className={cn(
                                                "min-h-0 flex-1 flex-col gap-0",
                                                navigationMotion.present
                                                    ? cn(
                                                          "fixed inset-y-0 left-0 z-[131] flex w-[85vw] max-w-[85vw] border-r border-border/80 bg-sidebar px-3 py-3 shadow-xl sm:static sm:z-auto sm:w-auto sm:max-w-none sm:translate-x-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:shadow-none sm:transition-none",
                                                          navigationMotion.animate &&
                                                              "max-sm:motion-safe:transition-transform max-sm:motion-safe:duration-[280ms] max-sm:motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]",
                                                          navigationMotion.shown
                                                              ? "max-sm:translate-x-0"
                                                              : "max-sm:-translate-x-full",
                                                      )
                                                    : "hidden sm:flex",
                                            )}
                                            onTransitionEnd={navigationMotion.onTransitionEnd}
                                        >
                                            <div className="flex shrink-0 items-center gap-3 py-4 pl-2 sm:hidden">
                                                <MortyLogoMark size={36} />
                                                <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">
                                                    Morty
                                                </span>
                                            </div>
                                            {desktop && (
                                                <nav
                                                    aria-label="Session actions"
                                                    className="box-border hidden min-w-0 w-full shrink-0 flex-col gap-0.5 sm:mt-2 sm:mb-3 sm:flex"
                                                >
                                                    <SidebarSessionOption
                                                        icon={MessageSquarePlus}
                                                        label="New Session"
                                                        testId={dataTestId.newConversation}
                                                        onClick={onNewConversation}
                                                    />
                                                    <SidebarSessionOption
                                                        icon={Laptop}
                                                        label="Open Session"
                                                        onClick={dialogs.getState().openNativeDialog}
                                                    />
                                                </nav>
                                            )}
                                            {desktop && (
                                                <div className="hidden min-h-0 flex-1 sm:flex sm:min-h-0 sm:flex-col sm:gap-0">
                                                    <Tooltip.Provider delayDuration={150}>
                                                        <div className="flex min-w-0 items-center justify-between gap-2.5 pl-2.5 sm:mb-0 sm:w-full sm:pl-3.5">
                                                            <h2 className="font-inter text-13 font-semibold tracking-normal text-copy-secondary">
                                                                Recent sessions
                                                            </h2>
                                                            <SidebarActionTooltip
                                                                label={
                                                                    refreshing
                                                                        ? "Refreshing sessions"
                                                                        : "Refresh sessions"
                                                                }
                                                            >
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="size-8! min-h-8! shrink-0 rounded-lg text-morty-text-3 hover:text-foreground"
                                                                    aria-label={
                                                                        refreshing
                                                                            ? "Refreshing sessions"
                                                                            : "Refresh sessions"
                                                                    }
                                                                    aria-busy={refreshing}
                                                                    disabled={refreshing}
                                                                    onClick={(event) => {
                                                                        blurAfterPointerClick(event);
                                                                        workspace.refreshDirectory();
                                                                    }}
                                                                >
                                                                    <RefreshCw
                                                                        className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                                                    />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                        </div>
                                                        <ScrollEdgeFade
                                                            id="chat-conversations"
                                                            fadeClassName="right-2"
                                                            fadeFromClassName="from-sidebar"
                                                            fadeToClassName="to-sidebar/0"
                                                            topFadeClassName="top-6 h-6"
                                                            frameClassName="col-span-2 -ml-3 -mr-3 box-border flex min-h-0 min-w-0 w-[calc(100%+24px)] max-w-none flex-1 flex-col max-sm:row-start-2 sm:-ml-2.5 sm:-mr-2.5 sm:w-[calc(100%+20px)]"
                                                            className={cn(
                                                                "min-h-0 flex-1 space-y-0 overflow-y-auto px-3 sm:px-2.5",
                                                                mortyThinScrollbarClassName,
                                                            )}
                                                        >
                                                            <ManagedSessionDirectoryList {...sessionListProps} />
                                                        </ScrollEdgeFade>
                                                    </Tooltip.Provider>
                                                </div>
                                            )}
                                            <Tooltip.Provider delayDuration={150} disableHoverableContent>
                                                <div className="col-span-2 flex w-full min-w-0 flex-col gap-0 overflow-y-auto pt-1 max-sm:min-h-0 max-sm:flex-1 sm:mt-auto sm:shrink-0 sm:flex-row sm:items-center sm:justify-between sm:gap-1 sm:overflow-visible sm:pt-3">
                                                    {!desktop && workspace.computers !== null ? (
                                                        <div className={mobileDrawerCardClassName}>
                                                            <ComputerSwitcher
                                                                context={executionContext}
                                                                layout="list"
                                                                model={workspace.computers}
                                                                name={computerName}
                                                                onChooseCurrent={dialogs.getState().closeMobileNav}
                                                                status={connectionStatus}
                                                            />
                                                        </div>
                                                    ) : null}
                                                    {!desktop && (
                                                        <nav
                                                            aria-label="Account actions"
                                                            className={cn(
                                                                mobileDrawerCardClassName,
                                                                mobileDrawerOptionDividerClassName,
                                                                "sm:hidden",
                                                                workspace.computers !== null && "mt-4",
                                                            )}
                                                        >
                                                            <SidebarSessionOption
                                                                icon={Share2}
                                                                label="Continue on another device"
                                                                variant="card"
                                                                onClick={dialogs.getState().openSharing}
                                                            />
                                                            <BugReportButton
                                                                appearance="card"
                                                                daemonSource={sessionDiagnostics}
                                                                dialog={workspace.bugReportDialog}
                                                            />
                                                        </nav>
                                                    )}
                                                    {!desktop && access.state.kind !== "ended" ? (
                                                        <nav
                                                            aria-label="Connection actions"
                                                            className={cn(
                                                                mobileDrawerCardClassName,
                                                                mobileDrawerOptionDividerClassName,
                                                                "mt-4 sm:hidden",
                                                            )}
                                                        >
                                                            <SidebarSessionOption
                                                                disabled={access.state.kind === "loading"}
                                                                icon={Wifi}
                                                                label="Network latency"
                                                                variant="card"
                                                                onClick={measureNetwork}
                                                            />
                                                            <SidebarSessionOption
                                                                disabled={
                                                                    access.state.kind === "loading" ||
                                                                    access.state.kind === "ending"
                                                                }
                                                                icon={LogOut}
                                                                label="End current access"
                                                                variant="card"
                                                                onClick={() => {
                                                                    void access.requestEnd(
                                                                        workspace.operationsSignal(),
                                                                    );
                                                                }}
                                                            />
                                                        </nav>
                                                    ) : null}
                                                    {desktop && access.state.kind !== "ended" ? (
                                                        <SidebarUserMenu
                                                            disabled={access.state.kind === "loading"}
                                                            endAccessDisabled={
                                                                access.state.kind === "loading" ||
                                                                access.state.kind === "ending"
                                                            }
                                                            onEndAccess={() => {
                                                                void access.requestEnd(workspace.operationsSignal());
                                                            }}
                                                            onMeasureNetwork={measureNetwork}
                                                        />
                                                    ) : null}
                                                    {desktop ? (
                                                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                                            <SidebarActionTooltip
                                                                label="Continue on another device"
                                                                side="top"
                                                            >
                                                                <Button
                                                                    aria-label="Continue on another device"
                                                                    className="size-8! min-h-8! shrink-0 justify-center rounded-lg px-0"
                                                                    data-testid={dataTestId.shareIdentity}
                                                                    onClick={(event) => {
                                                                        blurAfterPointerClick(event);
                                                                        dialogs.getState().openSharing();
                                                                    }}
                                                                    size="icon"
                                                                    variant="ghost"
                                                                >
                                                                    <Share2 aria-hidden="true" className="size-4" />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                            <BugReportButton
                                                                appearance="icon"
                                                                daemonSource={sessionDiagnostics}
                                                                dialog={workspace.bugReportDialog}
                                                            />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </Tooltip.Provider>
                                        </div>
                                        {dialogStore !== null && (
                                            <NativeSessionDialog
                                                store={dialogStore}
                                                sessions={sessions ?? []}
                                                agents={nativeAgents}
                                                onClose={dialogs.getState().closeNativeDialog}
                                                bugReportDialog={workspace.bugReportDialog}
                                                daemonSource={sessionDiagnostics}
                                            />
                                        )}
                                        {sharingStore !== null && (
                                            <Dialog
                                                title="Continue on another device"
                                                description={
                                                    <>
                                                        <span className="block">
                                                            Anyone with this link can use your current Morty identity to
                                                            view and control sessions in this project, not just the
                                                            current conversation.
                                                        </span>
                                                        <span className="mt-2 block">
                                                            New devices can join for 24 hours after the link is created.
                                                            Access already granted does not end when the link expires.
                                                        </span>
                                                    </>
                                                }
                                                onClose={dialogs.getState().closeSharing}
                                            >
                                                <IdentitySharing store={sharingStore} />
                                            </Dialog>
                                        )}
                                        {diagnostic.state.kind !== "closed" && (
                                            <Dialog
                                                title="Network latency"
                                                description={
                                                    <>
                                                        <span className="block">
                                                            Round-trip latency for this browser and its connected
                                                            Runtime.
                                                        </span>
                                                        <span className="mt-1 block">
                                                            Mobius location:{" "}
                                                            {projectLocationLabel(workspace.projectId ?? "")}
                                                        </span>
                                                    </>
                                                }
                                                headerAction={
                                                    <Button
                                                        aria-label="Refresh network latency"
                                                        disabled={diagnostic.state.kind === "measuring"}
                                                        onClick={measureNetwork}
                                                        size="icon"
                                                        title="Refresh network latency"
                                                        variant="ghost"
                                                    >
                                                        <RefreshCw
                                                            aria-hidden="true"
                                                            className={`size-4 ${diagnostic.state.kind === "measuring" ? "animate-spin" : ""}`}
                                                        />
                                                    </Button>
                                                }
                                                onClose={diagnostic.close}
                                            >
                                                {diagnostic.state.kind === "measuring" ? (
                                                    <div
                                                        aria-label="Measuring network latency"
                                                        className="flex items-center gap-2 text-muted-foreground"
                                                        role="status"
                                                    >
                                                        <LoaderCircle
                                                            aria-hidden="true"
                                                            className="size-4 animate-spin"
                                                        />
                                                        Measuring network latency…
                                                    </div>
                                                ) : diagnostic.state.kind === "failed" ? (
                                                    <div className="space-y-4">
                                                        <p className="text-destructive" role="alert">
                                                            {diagnostic.state.message}
                                                        </p>
                                                        <Button onClick={measureNetwork} variant="outline">
                                                            Try again
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <dl className="divide-y divide-border rounded-lg border border-border">
                                                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                                                            <dt>Browser ↔ Morty</dt>
                                                            <dd
                                                                aria-label="Browser to Morty latency"
                                                                className="font-mono font-medium"
                                                                role="status"
                                                            >
                                                                {diagnostic.state.browserMortyLatencyMs} ms
                                                            </dd>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                                                            <dt>Browser ↔ Mobius</dt>
                                                            <dd
                                                                aria-label="Browser to Mobius latency"
                                                                className="font-mono font-medium"
                                                                role="status"
                                                            >
                                                                {diagnostic.state.browserMobiusLatencyMs} ms
                                                            </dd>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                                                            <dt>Morty ↔ Mobius</dt>
                                                            <dd
                                                                aria-label="Morty to Mobius latency"
                                                                className="font-mono font-medium"
                                                                role="status"
                                                            >
                                                                {diagnostic.state.mortyMobiusLatencyMs} ms
                                                            </dd>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                                                            <dt>Mobius ↔ Daemon</dt>
                                                            <dd
                                                                aria-label="Mobius to daemon latency"
                                                                className="font-mono font-medium"
                                                                role="status"
                                                            >
                                                                {diagnostic.state.mobiusDaemonLatencyMs} ms
                                                            </dd>
                                                        </div>
                                                    </dl>
                                                )}
                                            </Dialog>
                                        )}
                                        {(access.state.kind === "loading" ||
                                            access.state.kind === "unavailable" ||
                                            access.state.kind === "confirming-end" ||
                                            access.state.kind === "ending" ||
                                            access.state.kind === "failed") && (
                                            <Dialog
                                                busy={access.state.kind === "loading" || access.state.kind === "ending"}
                                                title="End current access?"
                                                description={
                                                    <>
                                                        <span className="block">
                                                            End access in this browser. If you joined through a link,
                                                            that link and the browser access it granted will also be
                                                            revoked.
                                                        </span>
                                                        <span className="mt-2 block">
                                                            Other sharing links and recovery access stay active.
                                                            Already-open sessions elsewhere may keep working until their
                                                            access expires.
                                                        </span>
                                                        <span className="mt-3 block font-medium text-foreground">
                                                            Your local agent and tasks keep running.
                                                        </span>
                                                    </>
                                                }
                                                testId={dataTestId.endRemoteAccessDialog}
                                                onClose={access.cancel}
                                            >
                                                {access.state.kind === "loading" && (
                                                    <p role="status">Preparing current access…</p>
                                                )}
                                                {(access.state.kind === "failed" ||
                                                    access.state.kind === "unavailable") && (
                                                    <p className="mt-3 text-sm text-destructive" role="alert">
                                                        {access.state.message}
                                                    </p>
                                                )}
                                                <div className="mt-5 flex justify-end gap-2">
                                                    <Button
                                                        disabled={
                                                            access.state.kind === "loading" ||
                                                            access.state.kind === "ending"
                                                        }
                                                        onClick={access.cancel}
                                                        variant="ghost"
                                                    >
                                                        Cancel
                                                    </Button>
                                                    <Button
                                                        disabled={
                                                            access.state.kind === "loading" ||
                                                            access.state.kind === "ending"
                                                        }
                                                        onClick={() => {
                                                            if (access.state.kind === "unavailable") {
                                                                void access.requestEnd(workspace.operationsSignal());
                                                            } else {
                                                                void access.end(workspace.operationsSignal());
                                                            }
                                                        }}
                                                        variant="primary"
                                                    >
                                                        {access.state.kind === "ending"
                                                            ? "Ending…"
                                                            : access.state.kind === "failed" ||
                                                                access.state.kind === "unavailable"
                                                              ? "Try again"
                                                              : "End current access"}
                                                    </Button>
                                                </div>
                                            </Dialog>
                                        )}
                                    </aside>
                                    {sessionsMotion.present && typeof document !== "undefined"
                                        ? createPortal(
                                              <>
                                                  <button
                                                      type="button"
                                                      aria-label="Close recent sessions"
                                                      className={cn(
                                                          "fixed inset-0 z-[120] bg-black/30 sm:hidden",
                                                          sessionsMotion.animate && panelMotionClassName,
                                                          sessionsMotion.shown ? "opacity-100" : "opacity-0",
                                                      )}
                                                      onClick={() => dialogs.getState().dismissMobileRecentSessions()}
                                                  />
                                                  <div
                                                      id="chat-conversations-mobile-sheet"
                                                      data-testid={dataTestId.mobileRecentSessionsSheet}
                                                      role="dialog"
                                                      aria-modal="true"
                                                      aria-labelledby="mobile-recent-sessions-title"
                                                      className={cn(
                                                          "pointer-events-auto fixed inset-x-0 bottom-0 z-[121] flex h-[80dvh] max-h-[80dvh] flex-col rounded-t-[24px] bg-card shadow-[0_-8px_32px_rgba(17,24,20,0.12)] sm:hidden",
                                                          sessionsMotion.animate && panelMotionClassName,
                                                          sessionsMotion.shown ? "translate-y-0" : "translate-y-full",
                                                      )}
                                                      onTransitionEnd={sessionsMotion.onTransitionEnd}
                                                  >
                                                      <header className="flex shrink-0 items-center justify-between gap-2 pt-4 pr-3 pb-2 pl-5">
                                                          <h2
                                                              id="mobile-recent-sessions-title"
                                                              className="font-inter text-16 font-semibold tracking-normal text-morty-text-2"
                                                          >
                                                              Recent sessions
                                                          </h2>
                                                          <div className="flex shrink-0 items-center gap-2">
                                                              <Button
                                                                  variant="ghost"
                                                                  size="icon"
                                                                  className={mobileHeaderIconButtonClassName}
                                                                  aria-label={
                                                                      refreshing
                                                                          ? "Refreshing sessions"
                                                                          : "Refresh sessions"
                                                                  }
                                                                  aria-busy={refreshing}
                                                                  disabled={refreshing}
                                                                  title={
                                                                      refreshing
                                                                          ? "Refreshing sessions"
                                                                          : "Refresh sessions"
                                                                  }
                                                                  onClick={(event) => {
                                                                      blurAfterPointerClick(event);
                                                                      workspace.refreshDirectory();
                                                                  }}
                                                              >
                                                                  <RefreshCw
                                                                      aria-hidden="true"
                                                                      className={`size-5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                                                  />
                                                              </Button>
                                                              <Button
                                                                  variant="ghost"
                                                                  size="icon"
                                                                  className={mobileHeaderIconButtonClassName}
                                                                  aria-label="Close recent sessions"
                                                                  onClick={closeMobileRecentSessions}
                                                              >
                                                                  <X aria-hidden="true" className="size-5" />
                                                              </Button>
                                                          </div>
                                                      </header>
                                                      <ScrollEdgeFade
                                                          id="chat-conversations-mobile"
                                                          fadeClassName="right-2"
                                                          fadeFromClassName="from-card"
                                                          fadeToClassName="to-card/0"
                                                          topFadeClassName="top-0 h-8"
                                                          frameClassName="flex min-h-0 flex-1 flex-col"
                                                          className={cn(
                                                              "min-h-0 flex-1 space-y-0 overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
                                                              mortyThinScrollbarClassName,
                                                          )}
                                                      >
                                                          <ManagedSessionDirectoryList {...sessionListProps} />
                                                      </ScrollEdgeFade>
                                                  </div>
                                              </>,
                                              document.body,
                                          )
                                        : null}
                                </>
                            )}
                        </PanelPresence>
                    )}
                </PanelPresence>
            )}
        </DesktopChatLayout>
    );
}
