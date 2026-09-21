import { MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer, type ComposerAttachment } from "../../components/chat/bot-chat-composer.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { SelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer, WorkspaceLocation } from "../../services/identity/anonymous-identity-api.ts";
import {
    createBotChatHomeStore,
    disconnectedBotNotice,
    type SessionConnectionKind,
    setupDescription,
} from "../../view-models/chat/bot-chat-home-store.ts";
import {
    conversationComposerLocked,
    conversationCreationBusy,
    conversationCreationError,
    conversationCreationStatus,
    queuedDraftMessage,
} from "../../view-models/chat/conversation-creation-machine.ts";
import type { SessionActivityState } from "../../view-models/chat/session-activity-machine.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";
import { WorkspaceRegionSelector } from "./workspace-region-selector.tsx";

type ActiveSessionStatus =
    | { readonly kind: "none" }
    | { readonly kind: "status"; readonly sessionId: string; readonly status: SessionActivityState };

export function BotChatHome({
    requests,
    createTransfer,
    endRemoteAccess,
    projectId,
    replaceWorkspace,
    selectedBotPreference,
}: {
    readonly requests: Pick<
        BotChatApi,
        | "listBots"
        | "createBot"
        | "deleteBot"
        | "access"
        | "archiveManagedSession"
        | "workspace"
        | "workspaceDirectory"
        | "waitForWorkspaceChange"
        | "nativeSessions"
        | "nativeSession"
        | "managedSessions"
        | "managedSession"
        | "steerTurn"
        | "continueNativeSession"
        | "connectSession"
        | "createPairingInstruction"
        | "createConversation"
        | "conversationSession"
        | "submitTurn"
        | "agentSettings"
    >;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
    readonly projectId: string;
    readonly selectedBotPreference: SelectedBotPreference;
    readonly replaceWorkspace?: (location: WorkspaceLocation, signal: AbortSignal) => Promise<void>;
}) {
    const [store] = useState(() =>
        createBotChatHomeStore(requests, {
            url: window.location.href,
            createId: () => crypto.randomUUID(),
            navigation: {
                showDraft: () => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("conversation");
                    url.searchParams.delete("conversationId");
                    url.searchParams.delete("sessionId");
                    url.searchParams.delete("remoteAccess");
                    window.history.replaceState(window.history.state, "", url);
                },
                showManaged: (kind, id) => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("conversationId");
                    url.searchParams.delete("sessionId");
                    url.searchParams.delete("remoteAccess");
                    url.searchParams.set(kind === "conversation" ? "conversationId" : "sessionId", id);
                    window.history.replaceState(window.history.state, "", url);
                },
                showContinuedSession: (sessionId) => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("harness");
                    url.searchParams.delete("nativeSessionAction");
                    url.searchParams.set("sessionId", sessionId);
                    window.history.replaceState(window.history.state, "", url);
                },
                showForkInstead: () => {
                    const url = new URL(window.location.href);
                    url.searchParams.set("nativeSessionAction", "fork");
                    window.history.replaceState(window.history.state, "", url);
                },
            },
            selectedBotPreference,
        }),
    );
    const model = useStore(store);
    const [draft, setDraft] = useState("");
    const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
    const [failureDialogOpen, setFailureDialogOpen] = useState(false);
    const [disconnectedNotificationDismissed, setDisconnectedNotificationDismissed] = useState(false);
    const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
    const [activeSessionStatus, setActiveSessionStatus] = useState<ActiveSessionStatus>({ kind: "none" });
    const lifetime = useRef<AbortController | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const messageContent = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    const entryConnectionResolved = useRef(false);
    const [remoteAccess] = useState(() => new URL(window.location.href).searchParams.get("remoteAccess") === "1");
    const connectionStatus = model.connectionStatus;
    const disconnectionNotice = disconnectedBotNotice(model.view, connectionStatus);
    const creationBusy = conversationCreationBusy(model.creation);
    const composerLocked = conversationComposerLocked(model.creation);
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const setupView = model.view.kind === "setup" ? model.view : null;
    const disconnectedBot =
        setupView !== null && (setupView.reason === "agent-offline" || setupView.reason === "agent-required");

    // biome-ignore lint/correctness/useExhaustiveDependencies: Store revision explicitly restarts route loading.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void store
            .getState()
            .load(controller.signal)
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    reportApplicationError(cause, "chat-home-load");
                }
            });
        return () => {
            controller.abort();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [model.revision, store]);

    useEffect(() => {
        if (model.view.kind === "draft") {
            setPairingDialogOpen(false);
            setFailureDialogOpen(false);
        }
        if (
            entryConnectionResolved.current ||
            model.view.kind === "loading" ||
            model.view.kind === "connecting" ||
            model.view.kind === "switching"
        ) {
            return;
        }
        entryConnectionResolved.current = true;
        if (model.view.kind === "connection-failed") {
            setFailureDialogOpen(true);
        } else if (setupView !== null) {
            setPairingDialogOpen(true);
        }
    }, [model.view.kind, setupView]);

    useLayoutEffect(() => {
        if (model.view.kind === "draft" && followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [model.view]);
    useLayoutEffect(() => {
        const list = messageList.current;
        const content = messageContent.current;
        if (model.sessionView.kind !== "conversation-access" || list === null || content === null) {
            return;
        }
        const keepLatestVisible = () => {
            if (followLatest.current) {
                list.scrollTop = list.scrollHeight;
            }
        };
        const observer = new ResizeObserver(keepLatestVisible);
        observer.observe(list);
        observer.observe(content);
        keepLatestVisible();
        return () => observer.disconnect();
    }, [model.sessionView]);

    const active =
        model.view.kind === "switching"
            ? model.view.view
            : model.view.kind === "connecting" ||
                model.view.kind === "session-loading" ||
                model.view.kind === "draft" ||
                model.view.kind === "setup" ||
                model.view.kind === "runtime-disconnected" ||
                model.view.kind === "connection-failed" ||
                model.view.kind === "session-failed"
              ? model.view
              : null;
    const switching = model.view.kind === "switching";
    const onStatusChange = useCallback((sessionId: string, status: SessionActivityState): void => {
        setActiveSessionStatus({ kind: "status", sessionId, status });
    }, []);
    const onConnectionStatusChange = useCallback(
        (sessionId: string, connection: SessionConnectionKind) => {
            store.getState().setSessionConnectionStatus(sessionId, connection);
        },
        [store],
    );
    const activeSession =
        model.sessionView.kind === "session-access"
            ? {
                  kind: "active" as const,
                  directoryLabel: model.sessionView.session.entry.directoryLabel,
                  id: model.sessionView.session.result.ready.sessionId,
                  status:
                      activeSessionStatus.kind === "status" &&
                      activeSessionStatus.sessionId === model.sessionView.session.result.ready.sessionId
                          ? activeSessionStatus.status.kind
                          : "idle",
              }
            : { kind: "none" as const };
    const clearComposer = () => {
        setDraft("");
        setAttachments([]);
        followLatest.current = true;
    };
    const newConversation = () => {
        clearComposer();
        store.getState().newConversation();
    };
    const openManaged = (kind: "conversation" | "fork" | "import", id: string) => {
        clearComposer();
        store.getState().openManaged(kind, id);
    };
    const send = async () => {
        const controller = lifetime.current;
        if (controller === null) {
            return;
        }
        if (await store.getState().createConversation(draft, attachments, controller.signal)) {
            clearComposer();
        }
    };

    return (
        <main
            aria-label="Chat"
            data-chat-state={model.sessionView.kind === "session-access" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-background text-foreground max-sm:flex-col sm:flex-row"
        >
            {active !== null && (
                <ConversationSidebar
                    activeBot={active.bot}
                    activeSession={activeSession}
                    activeId={
                        model.target.kind === "conversation-access"
                            ? model.target.conversationId
                            : model.target.kind === "session-access"
                              ? model.target.sessionId
                              : ""
                    }
                    directoryRevision={model.directoryRevision}
                    bots={model.bots}
                    botOperation={model.botOperation}
                    connectionStatus={connectionStatus}
                    onCreateBot={store.getState().createBot}
                    onPairAgain={() => setPairingDialogOpen(true)}
                    onRemoveBot={store.getState().removeBot}
                    onResetBotOperation={store.getState().resetBotOperation}
                    onSelectBot={store.getState().selectBot}
                    requests={requests}
                    createTransfer={createTransfer}
                    onOpen={(session) => openManaged(session.kind, session.id)}
                    onOpenSession={(session) => openManaged(session.result.action, session.result.ready.sessionId)}
                    onNewConversation={newConversation}
                    key={active.bot.botId}
                />
            )}
            {model.sessionView.kind === "session-access" && active !== null ? (
                <MobiusSessionPane
                    botId={active.bot.botId}
                    requests={requests}
                    key={model.sessionView.session.result.ready.sessionId}
                    session={model.sessionView.session}
                    onConnectionStatusChange={onConnectionStatusChange}
                    onStatusChange={onStatusChange}
                    {...(remoteAccess ? { endRemoteAccess } : {})}
                />
            ) : (
                <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <div
                        ref={messageList}
                        onScroll={(event) => {
                            const element = event.currentTarget;
                            followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        }}
                        className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-4 py-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10 lg:px-12"
                        role="log"
                        aria-label="Messages"
                    >
                        <div ref={messageContent} className="flex min-h-full flex-col gap-8">
                            {model.view.kind === "loading" ||
                            model.view.kind === "session-loading" ||
                            model.view.kind === "switching" ? (
                                <div className="m-auto">
                                    <Spinner
                                        label={
                                            model.view.kind === "switching"
                                                ? "Switching session"
                                                : model.view.kind === "session-loading"
                                                  ? "Loading session"
                                                  : "Connecting to your agent"
                                        }
                                    />
                                </div>
                            ) : model.view.kind === "failed" || model.view.kind === "session-failed" ? (
                                <div className="m-auto grid justify-items-center gap-4 text-center">
                                    <p data-testid={dataTestId.sessionLoadFailure} role="alert">
                                        {model.view.message}
                                    </p>
                                    {model.target.kind === "continue" && model.target.action === "import" ? (
                                        <Button onClick={store.getState().forkInstead}>Fork session instead</Button>
                                    ) : (
                                        <div className="flex flex-wrap justify-center gap-2">
                                            <Button onClick={store.getState().retry}>Reconnect</Button>
                                            <Button variant="outline" onClick={() => setPairingDialogOpen(true)}>
                                                Pair again
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ) : queuedInitialMessage !== null && creationStatus !== null ? (
                                <div className="mx-auto mt-auto w-full min-w-0 max-w-[920px]">
                                    <div data-testid={dataTestId.queuedMessage}>
                                        <UserPromptMessage
                                            images={queuedInitialMessage.attachments.flatMap((attachment) =>
                                                attachment.kind === "image" ? [attachment.image] : [],
                                            )}
                                            resources={queuedInitialMessage.attachments.flatMap((attachment) =>
                                                attachment.kind === "resource" ? [attachment.resource] : [],
                                            )}
                                            text={queuedInitialMessage.content}
                                        />
                                    </div>
                                    <p
                                        aria-live="polite"
                                        className="text-right text-xs text-muted-foreground"
                                        data-testid={dataTestId.initialMessageStatus}
                                        role="status"
                                    >
                                        {creationStatus}
                                    </p>
                                </div>
                            ) : active === null ? null : (
                                <div className="m-auto max-w-lg px-6 text-center" data-testid={dataTestId.chatLanding}>
                                    <span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[18px] bg-primary-subtle text-primary shadow-[inset_0_0_0_1px_rgba(34,123,78,0.08)]">
                                        <MessageSquare className="size-6" aria-hidden="true" />
                                    </span>
                                    <p className="mb-2 text-[11px] font-semibold tracking-[0.1em] text-primary uppercase">
                                        {model.view.kind === "connecting"
                                            ? "Connecting to agent"
                                            : "Ready to collaborate"}
                                    </p>
                                    <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em]">
                                        {active.bot.displayName}
                                    </h1>
                                    <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                        {model.view.kind === "connecting"
                                            ? "Chat is restoring access to this conversation."
                                            : "Ask a question, explore the workspace, or start a task with your local agent."}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                    {model.view.kind === "draft" && !switching && (
                        <BotChatComposer
                            attachments={attachments}
                            disabled={composerLocked}
                            draft={draft}
                            error={creationError}
                            onAttachmentsChange={setAttachments}
                            onDraftChange={setDraft}
                            onStop={() => {}}
                            onSubmit={() => void send()}
                            outputState="idle"
                            submitDisabled={
                                creationBusy ||
                                (draft.trim().length === 0 && attachments.length === 0) ||
                                model.draftSettings === null
                            }
                        >
                            <DraftChatControls
                                key={model.target.kind === "draft" ? model.target.key : "existing"}
                                botId={model.view.bot.botId}
                                requests={requests}
                                disabled={composerLocked}
                                onSettings={store.getState().setDraftSettings}
                            />
                        </BotChatComposer>
                    )}
                </section>
            )}
            {pairingDialogOpen && active !== null && (
                <Dialog
                    title={
                        disconnectedBot ? "Bot disconnected" : setupView === null ? "Pair agent again" : "Connect agent"
                    }
                    description={
                        setupView === null
                            ? "Paste this one-time instruction into your local agent, then return here after it connects."
                            : setupDescription(setupView.reason)
                    }
                    onClose={() => setPairingDialogOpen(false)}
                >
                    {setupView?.reason === "unconfigured" &&
                        model.bots.length === 1 &&
                        replaceWorkspace !== undefined && (
                            <WorkspaceRegionSelector projectId={projectId} replaceWorkspace={replaceWorkspace} />
                        )}
                    <PairingInstruction botId={active.bot.botId} requests={requests} />
                </Dialog>
            )}
            {failureDialogOpen && model.view.kind === "connection-failed" && (
                <Dialog
                    title="Runtime connection unavailable"
                    description={model.view.message}
                    onClose={() => setFailureDialogOpen(false)}
                    testId={dataTestId.runtimeSetupFailure}
                >
                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={() => {
                                setFailureDialogOpen(false);
                                store.getState().retry();
                            }}
                        >
                            Reconnect
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setFailureDialogOpen(false);
                                setPairingDialogOpen(true);
                            }}
                        >
                            Pair again
                        </Button>
                    </div>
                </Dialog>
            )}
            {disconnectionNotice.kind === "visible" && !disconnectedNotificationDismissed && (
                <div
                    aria-live="polite"
                    className="fixed top-4 right-4 z-[100] grid w-[calc(100%-2rem)] max-w-sm grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg sm:top-6 sm:right-6"
                    role="status"
                >
                    <div className="min-w-0">
                        <p className="font-medium">{disconnectionNotice.title}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {disconnectionNotice.description}
                        </p>
                    </div>
                    <button
                        aria-label="Dismiss disconnected Bot notification"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                        onClick={() => setDisconnectedNotificationDismissed(true)}
                        type="button"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            )}
        </main>
    );
}
