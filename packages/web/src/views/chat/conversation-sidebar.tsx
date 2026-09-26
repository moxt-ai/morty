import {
    Check,
    Copy,
    Laptop,
    List,
    LoaderCircle,
    LogOut,
    MessageSquare,
    RefreshCw,
    Repeat2,
    Share2,
    SquarePen,
    UserRound,
} from "lucide-react";
import { ContextMenu, DropdownMenu, Tooltip } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import type { BotConnectionStatus, BotOperation } from "../../view-models/chat/bot-chat-home-store.ts";
import { createConversationDirectoryStore } from "../../view-models/chat/conversation-directory-store.ts";
import { createRemoteAccessStore } from "../../view-models/chat/remote-access-store.ts";
import type { SessionActivityState } from "../../view-models/chat/session-activity-machine.ts";
import { BotSwitcherMenu } from "./bot-switcher-menu.tsx";
import { MachineSharing } from "./machine-sharing.tsx";
import { NativeSessionDialog, type OpenMobiusSession } from "./native-session-dialog.tsx";

function SidebarActionTooltip({ children, label }: { readonly children: ReactNode; readonly label: string }) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Content
                    className="z-[70] rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
                    side="bottom"
                    sideOffset={6}
                >
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </Tooltip.Content>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function UserTokenBackup({ token }: { readonly token: string }) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    return (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium">Back up this token</p>
            <p className="text-xs text-muted-foreground">
                Save this recovery token somewhere secure. It remains usable after remote access ends.
            </p>
            <div className="flex items-center gap-2">
                <Input
                    aria-label="Current user token"
                    className="font-mono text-xs"
                    data-testid={dataTestId.currentUserToken}
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    value={token}
                />
                <Button
                    aria-label="Copy current user token"
                    data-testid={dataTestId.copyUserToken}
                    onClick={() => {
                        if (navigator.clipboard === undefined) {
                            setCopy("failed");
                            return;
                        }
                        void navigator.clipboard.writeText(token).then(
                            () => setCopy("copied"),
                            () => setCopy("failed"),
                        );
                    }}
                    size="icon"
                    title="Copy current user token"
                    variant="outline"
                >
                    {copy === "copied" ? (
                        <Check aria-hidden="true" className="size-4" />
                    ) : (
                        <Copy aria-hidden="true" className="size-4" />
                    )}
                </Button>
            </div>
            {copy === "failed" && <p className="text-xs text-destructive">Select and copy the token manually.</p>}
        </div>
    );
}

export function ConversationSidebar({
    activeBot,
    bots,
    botOperation,
    connectionStatus,
    onCreateBot,
    onPairAgain,
    onRemoveBot,
    onResetBotOperation,
    onSelectBot,
    requests,
    activeId,
    onOpen,
    onOpenSession,
    onNewConversation,
    currentUserToken,
    endRemoteAccess,
    replaceCurrentUser,
    createTransfer,
    sessionStatuses,
    directoryRevision,
    optimisticTitles,
}: {
    readonly activeBot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly botOperation: BotOperation;
    readonly connectionStatus: BotConnectionStatus;
    readonly onCreateBot: (displayName: string, signal: AbortSignal) => Promise<boolean>;
    readonly onPairAgain: () => void;
    readonly onRemoveBot: (signal: AbortSignal) => Promise<boolean>;
    readonly onResetBotOperation: () => void;
    readonly onSelectBot: (botId: string) => void;
    readonly requests: Pick<
        BotChatApi,
        "archiveManagedSession" | "workspace" | "nativeSessions" | "nativeSession" | "managedSessions"
    >;
    readonly activeId: string;
    readonly directoryRevision: number;
    readonly optimisticTitles: ReadonlyMap<string, string>;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onOpenSession: (session: OpenMobiusSession) => void;
    readonly onNewConversation: () => void;
    readonly currentUserToken: (
        signal: AbortSignal,
    ) => Promise<{ readonly accessToken: string; readonly token: string }>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
    readonly replaceCurrentUser: (currentToken: string, replacementToken: string, signal: AbortSignal) => Promise<void>;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly sessionStatuses: ReadonlyMap<string, SessionActivityState>;
}) {
    const botId = activeBot.botId;
    const [store] = useState(() => createConversationDirectoryStore(botId, requests));
    const { archive, archiveSession, load, state: directory } = useStore(store);
    const [revision, refresh] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [remoteAccess] = useState(() =>
        createRemoteAccessStore({ currentToken: currentUserToken, endRemoteAccess, replaceCurrentUser }),
    );
    const access = useStore(remoteAccess);
    const lifetime = useRef<AbortController | null>(null);
    const sessions =
        directory.kind === "ready" || directory.kind === "refreshing" || directory.kind === "stale"
            ? directory.sessions.map((session) => ({
                  ...session,
                  title: optimisticTitles.get(session.id) ?? session.title,
              }))
            : null;
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
    return (
        <aside
            aria-label="Workspace navigation"
            className="grid min-h-0 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-y-2 overflow-hidden border-b border-border/80 bg-sidebar px-3 py-3 sm:flex sm:w-[280px] sm:flex-col sm:gap-0 sm:border-r sm:border-b-0 sm:px-3.5 sm:py-4"
        >
            <div className="col-start-1 row-start-1 flex items-center gap-3 px-1.5 sm:col-auto sm:row-auto sm:mb-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(34,123,78,0.18)]">
                    <MessageSquare className="size-[18px]" aria-hidden="true" />
                </span>
                <span className="hidden min-w-0 sm:block">
                    <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">Morty</h1>
                    <span className="block text-[11px] leading-4 text-muted-foreground">Local workspace</span>
                </span>
            </div>
            <BotSwitcherMenu
                activeBot={activeBot}
                bots={bots}
                connectionStatus={connectionStatus}
                operation={botOperation}
                onCreate={onCreateBot}
                onPairAgain={onPairAgain}
                onRemove={onRemoveBot}
                onResetOperation={onResetBotOperation}
                onSelect={onSelectBot}
            />
            <div className="col-start-1 row-start-2 flex min-w-0 items-center justify-between px-1 sm:col-auto sm:row-auto sm:mb-2">
                <h2 className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">
                    Conversations
                </h2>
                <Button
                    variant="ghost"
                    className="size-10 shrink-0 justify-center rounded-lg px-0 sm:hidden"
                    aria-label="Conversations"
                    aria-expanded={expanded}
                    aria-controls="chat-conversations"
                    onClick={() => setExpanded((value) => !value)}
                >
                    <List aria-hidden="true" className="size-5" />
                </Button>
                <Tooltip.Provider delayDuration={150}>
                    <div className="flex items-center gap-0.5">
                        <SidebarActionTooltip label="New Conversation">
                            <Button
                                aria-label="New Conversation"
                                className="size-8 rounded-lg"
                                data-testid={dataTestId.newConversation}
                                onClick={onNewConversation}
                                size="icon"
                                variant="ghost"
                            >
                                <SquarePen aria-hidden="true" className="size-3.5" />
                            </Button>
                        </SidebarActionTooltip>
                        <SidebarActionTooltip label="Native Sessions">
                            <Button
                                aria-label="Native Sessions"
                                className="size-8 rounded-lg"
                                onClick={() => setDialog(true)}
                                size="icon"
                                variant="ghost"
                            >
                                <Laptop aria-hidden="true" className="size-3.5" />
                            </Button>
                        </SidebarActionTooltip>
                        <SidebarActionTooltip label={refreshing ? "Refreshing conversations" : "Refresh conversations"}>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 rounded-lg"
                                aria-label={refreshing ? "Refreshing conversations" : "Refresh conversations"}
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
                        aria-label="Loading conversations"
                        className="space-y-1 animate-pulse motion-reduce:animate-none"
                        role="status"
                    >
                        <span className="sr-only">Loading conversations…</span>
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
                        <p className="text-sm font-medium text-foreground">No conversations yet</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Connect this Bot to start chatting.
                        </p>
                        <Button className="mt-3" onClick={onPairAgain} size="sm" variant="outline">
                            Connect Bot
                        </Button>
                    </div>
                )}
                {archive.kind === "failed" && (
                    <p role="alert" className="px-2 text-sm text-destructive">
                        {archive.message}
                    </p>
                )}
                {sessions !== null && sessions.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">Your Chat conversations will appear here.</p>
                )}
                {sessions?.map((session) => (
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
                                {sessionStatuses.get(session.id)?.kind === "working" ? (
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
                                    Archive conversation
                                </ContextMenu.Item>
                            </ContextMenu.Content>
                        </ContextMenu.Portal>
                    </ContextMenu.Root>
                ))}
            </div>
            <div className="col-start-2 row-start-2 flex items-center gap-1 sm:col-auto sm:row-auto sm:mt-3 sm:border-t sm:border-black/[0.06] sm:pt-3">
                {access.state.kind !== "ended" && (
                    <DropdownMenu.Root>
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
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                align="start"
                                className="z-[110] min-w-52 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg"
                                side="top"
                                sideOffset={6}
                            >
                                <DropdownMenu.Item
                                    className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 outline-none data-[highlighted]:bg-accent"
                                    data-testid={dataTestId.replaceCurrentUser}
                                    onSelect={() => {
                                        const controller = lifetime.current;
                                        if (controller !== null) {
                                            void access.requestReplacement(controller.signal);
                                        }
                                    }}
                                >
                                    <Repeat2 aria-hidden="true" className="size-4" />
                                    Replace current user
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
                <Button
                    aria-label="Share My Machine"
                    variant="ghost"
                    className="size-10 shrink-0 justify-center rounded-full px-0 text-copy-secondary hover:bg-white/70 sm:min-h-10 sm:flex-1 sm:justify-start sm:rounded-xl sm:px-3"
                    data-testid={dataTestId.shareMachine}
                    onClick={() => setSharing(true)}
                >
                    <Share2 className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Share My Machine</span>
                </Button>
            </div>
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
                    title="Share My Machine"
                    description="Scan the QR code or open the link on another device to use this workspace."
                    onClose={() => setSharing(false)}
                >
                    <MachineSharing createTransfer={createTransfer} />
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
                    <UserTokenBackup token={access.state.token} />
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
            {(access.state.kind === "editing-replacement" ||
                access.state.kind === "replacement-failed" ||
                access.state.kind === "replacing") && (
                <Dialog
                    busy={access.state.kind === "replacing"}
                    description="Back up the current token, then enter another user token for this workspace. Replacing the user ends remote access for the current user first."
                    onClose={access.cancel}
                    testId={dataTestId.replaceCurrentUserDialog}
                    title="Replace current user"
                >
                    <UserTokenBackup token={access.state.currentToken} />
                    <label className="mt-5 block space-y-2 font-medium" htmlFor="replacement-user-token">
                        Replacement user token
                        <Input
                            aria-label="Replacement user token"
                            autoComplete="off"
                            className="font-mono text-xs"
                            data-testid={dataTestId.replacementUserToken}
                            disabled={access.state.kind === "replacing"}
                            id="replacement-user-token"
                            onChange={(event) => access.updateReplacementToken(event.currentTarget.value)}
                            placeholder="mobius_recovery_v1.…"
                            value={access.state.replacementToken}
                        />
                    </label>
                    {access.state.kind === "replacement-failed" && (
                        <p className="mt-3 text-sm text-destructive" role="alert">
                            {access.state.message}
                        </p>
                    )}
                    <div className="mt-5 flex justify-end gap-2">
                        <Button disabled={access.state.kind === "replacing"} onClick={access.cancel} variant="ghost">
                            Cancel
                        </Button>
                        <Button
                            disabled={
                                access.state.kind === "replacing" || access.state.replacementToken.trim().length === 0
                            }
                            onClick={() => {
                                const controller = lifetime.current;
                                if (controller !== null) {
                                    void access.replace(controller.signal);
                                }
                            }}
                        >
                            {access.state.kind === "replacing" ? "Replacing…" : "Replace current user"}
                        </Button>
                    </div>
                </Dialog>
            )}
        </aside>
    );
}
