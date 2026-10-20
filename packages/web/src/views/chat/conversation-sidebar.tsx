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
} from "lucide-react";
import { ContextMenu, DropdownMenu, Tooltip } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { dataTestId } from "../../data-testid.ts";
import { useApiTransport } from "../../services/api/api-transport-context.tsx";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import type { BotConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import { createConversationDirectoryStore } from "../../view-models/chat/conversation-directory-store.ts";
import type { ConversationListStatus } from "../../view-models/chat/conversation-status-store.ts";
import { createNetworkDiagnosticStore } from "../../view-models/chat/network-diagnostic-store.ts";
import { projectLocationLabel } from "../../view-models/chat/project-location-label.ts";
import { createRemoteAccessStore } from "../../view-models/chat/remote-access-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { IdentitySharing } from "./identity-sharing.tsx";
import { NativeSessionDialog, type OpenMobiusSession } from "./native-session-dialog.tsx";

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
                <Tooltip.Content
                    className="z-[70] rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
                    side={side}
                    sideOffset={6}
                >
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </Tooltip.Content>
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

function ConnectionStatus({ status }: { readonly status: BotConnectionStatus }) {
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

export function ConversationSidebar({
    botId,
    connectionStatus,
    onConnectAgent,
    requests,
    activeId,
    onOpen,
    onOpenSession,
    onNewConversation,
    onSessionsLoaded,
    currentAccessToken,
    endRemoteAccess,
    createTransfer,
    sessionStatuses,
    directoryRevision,
    optimisticTitles,
    projectId,
}: {
    readonly botId: string;
    readonly connectionStatus: BotConnectionStatus;
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
    readonly directoryRevision: number;
    readonly optimisticTitles: ReadonlyMap<string, string>;
    readonly projectId: string;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onOpenSession: (session: OpenMobiusSession) => void;
    readonly onNewConversation: () => void;
    readonly onSessionsLoaded: (botId: string, sessions: readonly ManagedChatSession[]) => void;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly sessionStatuses: ReadonlyMap<string, ConversationListStatus>;
}) {
    const transport = useApiTransport();
    const [store] = useState(() => createConversationDirectoryStore(botId, requests));
    const { archive, archiveSession, load, state: directory } = useStore(store);
    const [revision, refresh] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [remoteAccess] = useState(() => createRemoteAccessStore({ currentAccessToken, endRemoteAccess }));
    const access = useStore(remoteAccess);
    const [networkDiagnostic] = useState(() =>
        createNetworkDiagnosticStore({
            measureBrowserMobius: transport.measureMobiusLatency,
            measureBrowserMorty: transport.measureMortyLatency,
            measureServerHops: (signal) => requests.networkDiagnostic(botId, signal),
        }),
    );
    const diagnostic = useStore(networkDiagnostic);
    const lifetime = useRef<AbortController | null>(null);
    const measureNetwork = () => {
        const controller = lifetime.current;
        if (controller !== null) {
            void diagnostic.measure(controller.signal).catch(() => undefined);
        }
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
    // The directory belongs to the active Bot, not to the selected Session.
    // Session selection is managed by the home view-model and must not restart
    // or cancel this independent directory workflow.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Creation and explicit refresh reload the persisted directory.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void load(controller.signal);
        return () => {
            controller.abort();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [directoryRevision, load, revision]);
    useEffect(() => {
        if (directory.kind === "ready") {
            onSessionsLoaded(botId, directory.sessions);
        }
    }, [botId, directory, onSessionsLoaded]);
    return (
        <aside
            aria-label="Morty navigation"
            className="grid min-h-0 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-y-2 overflow-hidden border-b border-border/80 bg-sidebar px-3 py-3 sm:flex sm:w-[280px] sm:flex-col sm:gap-0 sm:border-r sm:border-b-0 sm:px-3.5 sm:py-4"
        >
            <div className="col-start-1 row-start-1 flex items-center gap-3 px-1.5 sm:col-auto sm:row-auto sm:mb-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)]">
                    <MessageSquare className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="hidden min-w-0 sm:block">
                    <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Morty</h1>
                </span>
            </div>
            <ConnectionStatus status={connectionStatus} />
            <div className="col-start-1 row-start-2 flex min-w-0 items-center justify-between px-1 sm:col-auto sm:row-auto sm:mb-2">
                <h2 className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">
                    Recent sessions
                </h2>
                <Button
                    variant="ghost"
                    className="size-10 shrink-0 justify-center rounded-lg px-0 sm:hidden"
                    aria-label="Recent sessions"
                    aria-expanded={expanded}
                    aria-controls="chat-conversations"
                    onClick={() => setExpanded((value) => !value)}
                >
                    <List aria-hidden="true" className="size-5" />
                </Button>
                <Tooltip.Provider delayDuration={150}>
                    <div className="flex items-center gap-0.5">
                        <SidebarActionTooltip label="New Session">
                            <Button
                                aria-label="New Session"
                                className="size-8 rounded-lg"
                                data-testid={dataTestId.newConversation}
                                onClick={onNewConversation}
                                size="icon"
                                variant="ghost"
                            >
                                <SquarePen aria-hidden="true" className="size-3.5" />
                            </Button>
                        </SidebarActionTooltip>
                        <SidebarActionTooltip label="Open Session">
                            <Button
                                aria-label="Open Session"
                                className="size-8 rounded-lg"
                                onClick={() => setDialog(true)}
                                size="icon"
                                variant="ghost"
                            >
                                <Laptop aria-hidden="true" className="size-3.5" />
                            </Button>
                        </SidebarActionTooltip>
                        <SidebarActionTooltip label={refreshing ? "Refreshing sessions" : "Refresh sessions"}>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 rounded-lg"
                                aria-label={refreshing ? "Refreshing sessions" : "Refresh sessions"}
                                aria-busy={refreshing}
                                disabled={refreshing}
                                onClick={() => refresh((value) => value + 1)}
                            >
                                <RefreshCw
                                    className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                />
                            </Button>
                        </SidebarActionTooltip>
                    </div>
                </Tooltip.Provider>
            </div>
            <div
                id="chat-conversations"
                className={`${expanded ? "block" : "hidden"} col-span-2 row-start-3 max-h-48 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 sm:col-auto sm:row-auto sm:block sm:max-h-none`}
            >
                {directory.kind === "loading" && (
                    <div
                        aria-label="Loading sessions"
                        className="space-y-1 animate-pulse motion-reduce:animate-none"
                        role="status"
                    >
                        <span className="sr-only">Loading sessions…</span>
                        <div aria-hidden="true" className="px-3 py-2.5">
                            <div className="h-3.5 w-3/4 rounded-full bg-border" />
                        </div>
                        <div aria-hidden="true" className="px-3 py-2.5">
                            <div className="h-3.5 w-1/2 rounded-full bg-border" />
                        </div>
                        <div aria-hidden="true" className="px-3 py-2.5">
                            <div className="h-3.5 w-2/3 rounded-full bg-border" />
                        </div>
                    </div>
                )}
                {(directory.kind === "failed" || directory.kind === "stale") && (
                    <p role="alert" className="text-sm text-destructive">
                        {directory.message}
                    </p>
                )}
                {directory.kind === "setup-required" && (
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
                        {onConnectAgent !== null && (
                            <Button className="mt-3" onClick={onConnectAgent} size="sm" variant="outline">
                                Connect agent
                            </Button>
                        )}
                    </div>
                )}
                {archive.kind === "failed" && (
                    <p role="alert" className="px-2 text-sm text-destructive">
                        {archive.message}
                    </p>
                )}
                {sessions !== null && sessions.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">Your Chat sessions will appear here.</p>
                )}
                {conversationGroups?.map((group) => (
                    <section className="space-y-1" key={group.label}>
                        <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
                            {group.label}
                        </h3>
                        {group.sessions.map((session) => (
                            <ContextMenu.Root key={session.id}>
                                <ContextMenu.Trigger asChild>
                                    <button
                                        data-testid={dataTestId.managedConversation}
                                        type="button"
                                        aria-current={activeId === session.id ? "page" : undefined}
                                        disabled={connectionStatus.kind !== "connected"}
                                        onClick={() => {
                                            onOpen(session);
                                            setExpanded(false);
                                        }}
                                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-transparent px-3 py-2.5 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color,box-shadow] duration-150 hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent aria-[current=page]:bg-white aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_4px_rgba(17,24,20,0.08),inset_3px_0_0_var(--primary)] motion-reduce:transition-none"
                                    >
                                        <span className="min-w-0">
                                            <span className="block truncate">{session.title}</span>
                                            {session.directoryLabel.length > 0 && (
                                                <span
                                                    className="block truncate text-[11px] leading-4 font-normal text-copy-secondary"
                                                    title={session.directoryLabel}
                                                >
                                                    {session.directoryLabel}
                                                </span>
                                            )}
                                        </span>
                                        {(sessionStatuses.get(session.id) ?? session.status).kind === "working" ? (
                                            <span
                                                aria-label="Session working"
                                                className="inline-flex text-primary"
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
                                </ContextMenu.Trigger>
                                <ContextMenu.Portal>
                                    <ContextMenu.Content className="z-[110] min-w-40 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg">
                                        <ContextMenu.Item
                                            className="cursor-pointer rounded-md px-3 py-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                                            data-testid={dataTestId.archiveConversation}
                                            disabled={archive.kind === "archiving"}
                                            onSelect={() => {
                                                const controller = lifetime.current;
                                                if (controller !== null) {
                                                    void archiveSession(session.id, controller.signal);
                                                }
                                            }}
                                        >
                                            Close session
                                        </ContextMenu.Item>
                                    </ContextMenu.Content>
                                </ContextMenu.Portal>
                            </ContextMenu.Root>
                        ))}
                    </section>
                ))}
            </div>
            <Tooltip.Provider delayDuration={150} disableHoverableContent>
                <div className="col-start-2 row-start-2 flex items-center gap-1 sm:col-auto sm:row-auto sm:mt-3 sm:border-t sm:border-black/[0.06] sm:pt-3">
                    <BugReportButton
                        appearance="icon"
                        daemonSource={{
                            botId,
                            sessionId: activeId,
                            nativeSessionId: null,
                            read: (signal) => requests.daemonDiagnostics(botId, signal),
                            readNetwork: (signal) => requests.networkDiagnostic(botId, signal),
                        }}
                    />
                    {access.state.kind !== "ended" && (
                        <DropdownMenu.Root>
                            <SidebarActionTooltip label="User menu" side="top">
                                <DropdownMenu.Trigger asChild>
                                    <Button
                                        aria-label="User menu"
                                        className="min-h-10 shrink-0 rounded-full"
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
                                    <DropdownMenu.Item
                                        className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-destructive outline-none data-[highlighted]:bg-destructive/10"
                                        data-testid={dataTestId.endRemoteAccess}
                                        onSelect={() => {
                                            const controller = lifetime.current;
                                            if (controller !== null) {
                                                void access.requestEnd(controller.signal);
                                            }
                                        }}
                                    >
                                        <LogOut aria-hidden="true" className="size-4" />
                                        End remote access
                                    </DropdownMenu.Item>
                                </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                    )}
                    <SidebarActionTooltip label="Continue your work" side="top">
                        <Button
                            aria-label="Continue your work"
                            variant="ghost"
                            className="size-10 shrink-0 justify-center rounded-full px-0 text-copy-secondary hover:bg-white/70"
                            data-testid={dataTestId.shareIdentity}
                            onClick={() => setSharing(true)}
                        >
                            <Share2 className="size-4" aria-hidden="true" />
                        </Button>
                    </SidebarActionTooltip>
                </div>
            </Tooltip.Provider>
            {dialog && (
                <NativeSessionDialog
                    botId={botId}
                    requests={requests}
                    onClose={() => setDialog(false)}
                    onOpen={(session) => {
                        onOpenSession(session);
                        setDialog(false);
                        refresh((value) => value + 1);
                    }}
                />
            )}
            {sharing && (
                <Dialog
                    title="Continue your work"
                    description="Scan the QR code or open the link on another device to use Morty."
                    onClose={() => setSharing(false)}
                >
                    <IdentitySharing createTransfer={createTransfer} />
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
                            <span className="mt-1 block">Mobius location: {projectLocationLabel(projectId)}</span>
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
            {(access.state.kind === "confirming-end" ||
                access.state.kind === "ending" ||
                access.state.kind === "failed") && (
                <Dialog
                    busy={access.state.kind === "ending"}
                    title="End remote access?"
                    description="This will sign out every browser using this access link and prevent the link from being used again. Your local Runtime and task will keep running."
                    testId={dataTestId.endRemoteAccessDialog}
                    onClose={access.cancel}
                >
                    {access.state.kind === "failed" && (
                        <p className="mt-3 text-sm text-destructive" role="alert">
                            {access.state.message}
                        </p>
                    )}
                    <div className="mt-5 flex justify-end gap-2">
                        <Button disabled={access.state.kind === "ending"} onClick={access.cancel} variant="ghost">
                            Cancel
                        </Button>
                        <Button
                            disabled={access.state.kind === "ending"}
                            onClick={() => {
                                const controller = lifetime.current;
                                if (controller !== null) {
                                    void access.end(controller.signal);
                                }
                            }}
                            variant="destructive"
                        >
                            {access.state.kind === "ending" ? "Ending…" : "End remote access"}
                        </Button>
                    </div>
                </Dialog>
            )}
        </aside>
    );
}
