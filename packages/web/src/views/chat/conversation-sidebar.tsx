import {
    Laptop,
    List,
    LoaderCircle,
    LogOut,
    MessageSquare,
    RefreshCw,
    Share2,
    SquarePen,
    UserRound,
    Wifi,
    X,
} from "lucide-react";
import { ContextMenu, DropdownMenu, Tooltip } from "radix-ui";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { mortyThinScrollbarClassName } from "../../components/chat/chat-session-layout.ts";
import { panelMotionClassName, usePanelPresence } from "../../components/chat/sidebar-panel-presence.ts";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { useDesktopChatLayout } from "../../components/utils/use-desktop-chat-layout.ts";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import type { ConversationDirectoryStore } from "../../view-models/chat/conversation-directory-store.ts";
import type { ConversationListStatus } from "../../view-models/chat/conversation-status-store.ts";
import { projectLocationLabel } from "../../view-models/chat/project-location-label.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { ComputerSwitcher } from "./computer-switcher.tsx";
import { IdentitySharing } from "./identity-sharing.tsx";
import { NativeSessionDialog } from "./native-session-dialog.tsx";

function SidebarSessionOption({
    label,
    icon: Icon,
    onClick,
    testId,
    disabled = false,
    destructive = false,
}: {
    readonly label: string;
    readonly icon: typeof SquarePen;
    readonly onClick: () => void;
    readonly testId?: string;
    readonly disabled?: boolean;
    readonly destructive?: boolean;
}) {
    return (
        <button
            type="button"
            className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-[10px] py-2 text-left text-[13px] font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50",
                destructive
                    ? "text-destructive hover:bg-destructive/10 active:bg-destructive/15"
                    : "text-copy-secondary hover:bg-morty-fill-opacity-2 hover:text-foreground active:bg-morty-fill-opacity-3 active:text-foreground disabled:hover:text-copy-secondary disabled:active:text-copy-secondary",
            )}
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
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

interface ConversationGroup {
    readonly label: string;
    readonly sessions: readonly ManagedChatSession[];
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function localCalendarDay(date: Date): number {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function conversationGroupLabel(updatedAt: Date, now: Date): string {
    const daysAgo = Math.floor((localCalendarDay(now) - localCalendarDay(updatedAt)) / DAY_MILLISECONDS);
    if (daysAgo <= 0) {
        return "Today";
    }
    if (daysAgo === 1) {
        return "Yesterday";
    }
    if (daysAgo <= 7) {
        return "Previous 7 Days";
    }
    if (daysAgo <= 30) {
        return "Previous 30 Days";
    }
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(updatedAt);
}

function groupConversationsByUpdatedAt(
    sessions: readonly ManagedChatSession[],
    now: Date,
): readonly ConversationGroup[] {
    const groups: ConversationGroup[] = [];
    const sorted = sessions
        .map((session) => ({ session, updatedAt: new Date(session.updatedAt) }))
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    for (const { session, updatedAt } of sorted) {
        const label = conversationGroupLabel(updatedAt, now);
        const previous = groups.at(-1);
        if (previous?.label === label) {
            groups[groups.length - 1] = { label, sessions: [...previous.sessions, session] };
        } else {
            groups.push({ label, sessions: [session] });
        }
    }
    return groups;
}

function ManagedSessionDirectoryList({
    directory,
    archive,
    sessions,
    conversationGroups,
    activeId,
    connectionStatus,
    sessionStatuses,
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
    readonly onConnectAgent: (() => void) | null;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly archiveSession: ConversationDirectoryStore["archiveSession"];
    readonly operationsSignal: () => AbortSignal;
}) {
    return (
        <Tooltip.Provider delayDuration={150}>
            {(directory.kind === "failed" || directory.kind === "stale") && (
                <MortyAlert>{directory.message}</MortyAlert>
            )}
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
            {sessions !== null && sessions.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground sm:py-2">Your Chat sessions will appear here.</p>
            )}
            {conversationGroups?.map((group) => (
                <section className="mb-3 min-w-0 w-full space-y-0 last:mb-0" key={group.label}>
                    <h3 className="sticky top-0 z-[1] -mx-2 mb-0 bg-card px-[22px] pb-1 pt-1 text-11 font-normal text-morty-text-3 sm:-mx-3 sm:bg-sidebar">
                        {group.label}
                    </h3>
                    {group.sessions.map((session) => {
                        const sessionButton = (
                            <button
                                data-testid={dataTestId.managedConversation}
                                type="button"
                                aria-label={`Open ${session.title}`}
                                aria-current={activeId === session.id ? "page" : undefined}
                                disabled={connectionStatus.kind !== "connected"}
                                onClick={() => onOpen(session)}
                                className="box-border mb-0 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[20px] px-2.5 py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-copy-secondary aria-[current=page]:bg-morty-fill-opacity-3 aria-[current=page]:text-foreground aria-[current=page]:hover:bg-morty-fill-opacity-4 aria-[current=page]:hover:text-foreground aria-[current=page]:disabled:hover:text-foreground motion-reduce:transition-none"
                            >
                                <span className="min-w-0 truncate">{session.title}</span>
                                {(sessionStatuses.get(session.id) ?? session.status).kind === "working" ? (
                                    <span
                                        aria-label="Session working"
                                        className="inline-flex text-copy-secondary"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-4 animate-spin motion-reduce:animate-none"
                                        />
                                    </span>
                                ) : sessionStatuses.get(session.id)?.kind === "failed" ? (
                                    <span
                                        aria-label="Session failed"
                                        className="text-xs text-destructive"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        Failed
                                    </span>
                                ) : sessionStatuses.get(session.id)?.kind === "unread" ? (
                                    <span
                                        aria-label="Unread response"
                                        className="inline-flex size-4 items-center justify-center"
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
                                        <ContextMenu.Content className="z-[110] min-w-40 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg">
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
            ? "bg-primary"
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
    optimisticTitles,
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
    readonly optimisticTitles: ReadonlyMap<string, string>;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onNewConversation: () => void;
}) {
    // The workspace owns the sidebar's dialog, remote-access, and diagnostic
    // stores outside React; the view only subscribes.
    const dialogs = workspace.sidebar.dialogs;
    const computerName = useStore(workspace.home, (state) => state.runtimeConfiguration?.runtime.machineName ?? "");
    const directory = useStore(workspace.directory, (state) => state.state);
    const archive = useStore(workspace.directory, (state) => state.archive);

    const sessionStatuses = useStore(workspace.statuses, (state) => state.statuses);
    const dialogState = useStore(dialogs);
    const mobileNavOpen = dialogState.mobileNavOpen;
    const mobileSessionsOpen = dialogState.mobileSessionsOpen;
    const navigationMotion = usePanelPresence(mobileNavOpen);
    const sessionsMotion = usePanelPresence(mobileSessionsOpen);
    const desktop = useDesktopChatLayout();
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
        read: (signal: AbortSignal) => requests.daemonDiagnostics(botId, signal),
        readNetwork: (signal: AbortSignal) => requests.networkDiagnostic(botId, signal),
    };
    const measureNetwork = () => {
        void diagnostic.measure(workspace.operationsSignal()).catch(() => undefined);
    };
    const sessions =
        directory.kind === "ready" || directory.kind === "refreshing" || directory.kind === "stale"
            ? directory.sessions.map((session) => ({
                  ...session,
                  title: optimisticTitles.get(session.id) ?? session.title,
              }))
            : null;
    const conversationGroups = sessions === null ? null : groupConversationsByUpdatedAt(sessions, new Date());
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
        onConnectAgent,
        onOpen: openSession,
        archiveSession: workspace.directory.getState().archiveSession,
        operationsSignal: workspace.operationsSignal,
    };
    return (
        <>
            {navigationMotion.present ? (
                <button
                    type="button"
                    aria-label="Close navigation"
                    className={cn(
                        "fixed inset-0 z-[120] bg-black/30 sm:hidden",
                        navigationMotion.animate && panelMotionClassName,
                        navigationMotion.shown ? "opacity-100" : "opacity-0",
                    )}
                    onClick={dialogs.getState().closeMobileNav}
                />
            ) : null}
            <aside
                ref={dialogs.getState().onAttach}
                id="conversation-sidebar-mobile-panel"
                aria-label="Morty navigation"
                className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden bg-card/90 px-3 pt-0 max-sm:overflow-visible sm:w-[264px] sm:gap-0 sm:bg-sidebar sm:pt-2 sm:pb-4"
            >
                <header className="relative flex min-w-0 shrink-0 items-center justify-between gap-3 py-2 max-sm:z-[110] max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:bg-card/90">
                    <div className="relative z-[1] flex w-fit shrink-0 items-center gap-3">
                        <button
                            type="button"
                            aria-controls="conversation-sidebar-mobile-drawer"
                            aria-expanded={mobileNavOpen}
                            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
                            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)] outline-none transition-opacity hover:opacity-95 focus-visible:ring-2 focus-visible:ring-ring/60 sm:hidden"
                            onClick={() => {
                                mobileNavOpen
                                    ? dialogs.getState().closeMobileNav()
                                    : dialogs.getState().openMobileNav();
                                dialogs.getState().closeMobileRecentSessions();
                            }}
                        >
                            <MessageSquare className="size-4" aria-hidden="true" />
                        </button>
                        <span className="hidden size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)] sm:flex">
                            <MessageSquare className="size-4" aria-hidden="true" />
                        </span>
                        <span className="hidden min-w-0 sm:block">
                            <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Morty</h1>
                        </span>
                        <Button
                            variant="ghost"
                            className="ml-0 size-10 shrink-0 justify-center rounded-lg px-0 text-copy-secondary sm:hidden"
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
                        className="pointer-events-none flex min-w-0 flex-1 items-center justify-center overflow-hidden sm:hidden"
                    />
                    <div className="flex shrink-0 items-center justify-end gap-0.5">
                        <Tooltip.Provider delayDuration={150}>
                            {!desktop && (
                                <div className="flex items-center gap-3 sm:hidden">
                                    <SidebarActionTooltip label="New Session">
                                        <Button
                                            aria-label="New Session"
                                            className="size-10 shrink-0 justify-center rounded-lg px-0 text-copy-secondary"
                                            data-testid={dataTestId.newConversation}
                                            onClick={onNewConversation}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <SquarePen aria-hidden="true" className="size-5" />
                                        </Button>
                                    </SidebarActionTooltip>
                                    <SidebarActionTooltip label="Open Session">
                                        <Button
                                            aria-label="Open Session"
                                            className="size-10 shrink-0 justify-center rounded-lg px-0 text-copy-secondary"
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
                {workspace.computers !== null && (
                    <ComputerSwitcher model={workspace.computers} name={computerName} status={connectionStatus} />
                )}
                <div
                    id="conversation-sidebar-mobile-drawer"
                    className={cn(
                        "min-h-0 flex-1 flex-col gap-0",
                        navigationMotion.present
                            ? cn(
                                  "fixed inset-y-0 left-0 z-[130] flex w-[85vw] max-w-[85vw] border-r border-border/80 bg-sidebar px-3 pt-0 pb-3 shadow-xl sm:static sm:z-auto sm:w-auto sm:max-w-none sm:translate-x-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:pb-0 sm:shadow-none sm:transition-none",
                                  navigationMotion.animate &&
                                      "max-sm:motion-safe:transition-transform max-sm:motion-safe:duration-[280ms] max-sm:motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]",
                                  navigationMotion.shown ? "max-sm:translate-x-0" : "max-sm:-translate-x-full",
                              )
                            : "hidden sm:flex",
                    )}
                    onTransitionEnd={navigationMotion.onTransitionEnd}
                >
                    <div className="flex h-14 shrink-0 items-center gap-3 sm:hidden">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)]">
                            <MessageSquare className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">
                            Morty
                        </span>
                        <ConnectionStatus status={connectionStatus} />
                    </div>
                    {desktop && (
                        <nav
                            aria-label="Session actions"
                            className="box-border hidden min-w-0 w-full shrink-0 flex-col gap-0.5 sm:mt-2 sm:mb-3 sm:flex"
                        >
                            <SidebarSessionOption
                                icon={SquarePen}
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
                                <div className="flex min-w-0 items-center justify-between gap-2 pl-2 sm:mb-0 sm:w-full">
                                    <h2 className="font-inter text-13 font-semibold tracking-normal text-foreground">
                                        Recent sessions
                                    </h2>
                                    <SidebarActionTooltip
                                        label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                    >
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-8! min-h-8! shrink-0 rounded-lg text-morty-text-3 hover:text-foreground"
                                            aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                            aria-busy={refreshing}
                                            disabled={refreshing}
                                            onClick={() => workspace.refreshDirectory()}
                                        >
                                            <RefreshCw
                                                className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                            />
                                        </Button>
                                    </SidebarActionTooltip>
                                </div>
                                <div
                                    id="chat-conversations"
                                    className={cn(
                                        "col-span-2 -ml-3 -mr-3 box-border block min-h-0 min-w-0 w-[calc(100%+24px)] max-w-none flex-1 space-y-0 overflow-y-auto px-3 max-sm:row-start-2 max-sm:max-h-none sm:max-h-none",
                                        mortyThinScrollbarClassName,
                                    )}
                                >
                                    <ManagedSessionDirectoryList {...sessionListProps} />
                                </div>
                            </Tooltip.Provider>
                        </div>
                    )}
                    <Tooltip.Provider delayDuration={150} disableHoverableContent>
                        <div className="col-span-2 flex w-full min-w-0 shrink-0 flex-col gap-0.5 pt-3 sm:mt-auto sm:flex-row sm:items-center sm:justify-between sm:gap-1 sm:border-t sm:border-black/[0.06]">
                            {!desktop && (
                                <nav aria-label="Account actions" className="flex flex-col gap-0.5 sm:hidden">
                                    <SidebarSessionOption
                                        icon={Share2}
                                        label="Continue on another device"
                                        onClick={dialogs.getState().openSharing}
                                    />
                                    <BugReportButton
                                        appearance="option"
                                        daemonSource={sessionDiagnostics}
                                        dialog={workspace.bugReportDialog}
                                    />
                                    {access.state.kind !== "ended" ? (
                                        <>
                                            <div aria-hidden="true" className="my-2 h-px bg-black/[0.06]" />
                                            <SidebarSessionOption
                                                disabled={access.state.kind === "loading"}
                                                icon={Wifi}
                                                label="Network latency"
                                                onClick={measureNetwork}
                                            />
                                            <SidebarSessionOption
                                                destructive
                                                disabled={
                                                    access.state.kind === "loading" || access.state.kind === "ending"
                                                }
                                                icon={LogOut}
                                                label="End current access"
                                                onClick={() => {
                                                    void access.requestEnd(workspace.operationsSignal());
                                                }}
                                            />
                                        </>
                                    ) : null}
                                </nav>
                            )}
                            {desktop && access.state.kind !== "ended" ? (
                                <DropdownMenu.Root>
                                    <SidebarActionTooltip label="User menu" side="top">
                                        <DropdownMenu.Trigger asChild>
                                            <Button
                                                aria-label="User menu"
                                                className="shrink-0 rounded-full border border-white bg-black/[0.08] text-copy-secondary hover:bg-black/[0.12] active:bg-black/[0.16] data-[state=open]:bg-black/[0.16]"
                                                data-testid={dataTestId.userMenu}
                                                disabled={access.state.kind === "loading"}
                                                size="icon"
                                                variant="ghost"
                                            >
                                                {access.state.kind === "loading" ? (
                                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                                ) : (
                                                    <UserRound aria-hidden="true" className="size-4" />
                                                )}
                                            </Button>
                                        </DropdownMenu.Trigger>
                                    </SidebarActionTooltip>
                                    <DropdownMenu.Portal>
                                        <DropdownMenu.Content
                                            align="start"
                                            className="z-[110] min-w-52 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg"
                                            side="top"
                                            sideOffset={6}
                                        >
                                            <DropdownMenu.Item
                                                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 outline-none data-[highlighted]:bg-accent"
                                                onSelect={measureNetwork}
                                            >
                                                <Wifi aria-hidden="true" className="size-4" />
                                                Network latency
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Separator className="my-1 h-px bg-black/[0.06]" />
                                            <DropdownMenu.Item
                                                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-destructive outline-none data-[highlighted]:bg-destructive/10"
                                                data-testid={dataTestId.endRemoteAccess}
                                                disabled={
                                                    access.state.kind === "loading" || access.state.kind === "ending"
                                                }
                                                onSelect={() => {
                                                    void access.requestEnd(workspace.operationsSignal());
                                                }}
                                            >
                                                <LogOut aria-hidden="true" className="size-4" />
                                                End current access
                                            </DropdownMenu.Item>
                                        </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                            ) : null}
                            {desktop ? (
                                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                    <SidebarActionTooltip label="Continue on another device" side="top">
                                        <Button
                                            aria-label="Continue on another device"
                                            className="size-8! min-h-8! shrink-0 justify-center rounded-lg px-0"
                                            data-testid={dataTestId.shareIdentity}
                                            onClick={dialogs.getState().openSharing}
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
                    <NativeSessionDialog store={dialogStore} onClose={dialogs.getState().closeNativeDialog} />
                )}
                {sharingStore !== null && (
                    <Dialog
                        title="Continue on another device"
                        description={
                            <>
                                <span className="block">
                                    Anyone with this link can use your current Morty identity to view and control
                                    sessions in this project, not just the current conversation.
                                </span>
                                <span className="mt-2 block">
                                    New devices can join for 24 hours after the link is created. Access already granted
                                    does not end when the link expires.
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
                                    Round-trip latency for this browser and its connected Runtime.
                                </span>
                                <span className="mt-1 block">
                                    Mobius location: {projectLocationLabel(workspace.projectId ?? "")}
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
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
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
                                    End access in this browser. If you joined through a link, that link and the browser
                                    access it granted will also be revoked.
                                </span>
                                <span className="mt-2 block">
                                    Other sharing links and recovery access stay active. Already-open sessions elsewhere
                                    may keep working until their access expires.
                                </span>
                                <span className="mt-3 block font-medium text-foreground">
                                    Your local agent and tasks keep running.
                                </span>
                            </>
                        }
                        testId={dataTestId.endRemoteAccessDialog}
                        onClose={access.cancel}
                    >
                        {access.state.kind === "loading" && <p role="status">Preparing current access…</p>}
                        {(access.state.kind === "failed" || access.state.kind === "unavailable") && (
                            <p className="mt-3 text-sm text-destructive" role="alert">
                                {access.state.message}
                            </p>
                        )}
                        <div className="mt-5 flex justify-end gap-2">
                            <Button
                                disabled={access.state.kind === "loading" || access.state.kind === "ending"}
                                onClick={access.cancel}
                                variant="ghost"
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={access.state.kind === "loading" || access.state.kind === "ending"}
                                onClick={() => {
                                    if (access.state.kind === "unavailable") {
                                        void access.requestEnd(workspace.operationsSignal());
                                    } else {
                                        void access.end(workspace.operationsSignal());
                                    }
                                }}
                                variant="destructive"
                            >
                                {access.state.kind === "ending"
                                    ? "Ending…"
                                    : access.state.kind === "failed" || access.state.kind === "unavailable"
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
                                  "pointer-events-auto fixed inset-x-0 bottom-0 z-[121] flex h-[80dvh] max-h-[80dvh] flex-col rounded-t-[24px] border-t border-border/80 bg-card shadow-[0_-8px_32px_rgba(17,24,20,0.12)] sm:hidden",
                                  sessionsMotion.animate && panelMotionClassName,
                                  sessionsMotion.shown ? "translate-y-0" : "translate-y-full",
                              )}
                              style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
                              onTransitionEnd={sessionsMotion.onTransitionEnd}
                          >
                              <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-4">
                                  <h2
                                      id="mobile-recent-sessions-title"
                                      className="font-inter text-13 font-semibold tracking-normal text-morty-text-2"
                                  >
                                      Recent sessions
                                  </h2>
                                  <div className="flex shrink-0 items-center">
                                      <Button
                                          variant="ghost"
                                          size="icon"
                                          className="size-8 shrink-0 rounded-lg text-morty-text-3 hover:text-foreground"
                                          aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                          aria-busy={refreshing}
                                          disabled={refreshing}
                                          title={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                          onClick={() => workspace.refreshDirectory()}
                                      >
                                          <RefreshCw
                                              className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                          />
                                      </Button>
                                      <Button
                                          variant="ghost"
                                          size="icon"
                                          className="size-8 shrink-0 rounded-lg text-morty-text-3 hover:text-foreground"
                                          aria-label="Close recent sessions"
                                          onClick={closeMobileRecentSessions}
                                      >
                                          <X aria-hidden="true" className="size-3.5" />
                                      </Button>
                                  </div>
                              </header>
                              <div
                                  id="chat-conversations-mobile"
                                  className={cn(
                                      "min-h-0 flex-1 space-y-0 overflow-y-auto overscroll-contain px-2 pb-2",
                                      mortyThinScrollbarClassName,
                                  )}
                              >
                                  <ManagedSessionDirectoryList {...sessionListProps} />
                              </div>
                          </div>
                      </>,
                      document.body,
                  )
                : null}
        </>
    );
}
