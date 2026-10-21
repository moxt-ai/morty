import { MessageSquare, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer, type ComposerAttachment } from "../../components/chat/bot-chat-composer.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { disconnectedBotNotice } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import {
    conversationComposerLocked,
    conversationCreationBusy,
    conversationCreationError,
    conversationCreationStatus,
    queuedDraftMessage,
} from "../../view-models/chat/conversation-creation-machine.ts";
import { selectedConversationId } from "../../view-models/chat/conversation-selection-machine.ts";
import type { SessionActivityState } from "../../view-models/chat/session-activity-machine.ts";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

export function BotChatHome({
    workspace,
    requests,
    createTransfer,
    currentAccessToken,
    endRemoteAccess,
    projectId,
}: {
    readonly workspace: ChatWorkspace;
    readonly requests: Pick<
        BotChatApi,
        | "readBot"
        | "access"
        | "archiveManagedSession"
        | "runtimeConfiguration"
        | "directory"
        | "waitForSetupChange"
        | "waitForRuntimeConfigurationChange"
        | "nativeSessions"
        | "nativeSession"
        | "managedSessions"
        | "managedSession"
        | "subscribeManagedSessionStatuses"
        | "continueNativeSession"
        | "connectSession"
        | "createConversation"
        | "conversationSession"
        | "agentSettings"
        | "daemonDiagnostics"
        | "networkDiagnostic"
    >;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    readonly endRemoteAccess: (token: string, signal: AbortSignal) => Promise<void>;
    readonly projectId: string;
}) {
    const store = workspace.home;
    const model = useStore(store);
    const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
    const [disconnectedNotificationDismissed, setDisconnectedNotificationDismissed] = useState(false);
    const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
    const [followRevision, setFollowRevision] = useState(0);
    const rearmFollowing = () => {
        setFollowRevision((revision) => revision + 1);
    };
    const messageList = useRef<HTMLDivElement | null>(null);
    const connectionStatus = model.connectionStatus;
    const disconnectionNotice = disconnectedBotNotice(model.view, connectionStatus);
    const creationBusy = conversationCreationBusy(model.creation);
    const composerLocked = conversationComposerLocked(model.creation);
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const draft = model.draft;
    const setupView = model.view.kind === "setup" ? model.view : null;
    const pairingNotice = model.notices.pairing.kind === "visible" || pairingDialogOpen;
    const failureNotice = model.notices.connectionFailed.kind === "visible";

    const active =
        model.view.kind === "connecting" ||
        model.view.kind === "active" ||
        model.view.kind === "setup" ||
        model.view.kind === "runtime-disconnected" ||
        model.view.kind === "connection-failed"
            ? model.view
            : null;
    const activeBotId = active?.botId;
    const activeConversationId = selectedConversationId(model.selection);
    const onStatusChange = useCallback(
        (sessionId: string, status: SessionActivityState): void => {
            if (activeBotId !== undefined) {
                workspace.sessionStatusChanged(sessionId, status);
            }
        },
        [activeBotId, workspace],
    );
    const clearComposer = () => {
        store.getState().setDraft("");
        setAttachments([]);
        rearmFollowing();
    };
    const newConversation = () => {
        clearComposer();
        store.getState().newConversation();
    };
    const openManaged = (isExternal: boolean, id: string) => {
        setAttachments([]);
        rearmFollowing();
        store.getState().openManaged(isExternal, id);
    };
    const send = async () => {
        if (await store.getState().createConversation(draft, attachments, workspace.chatSignal())) {
            clearComposer();
        }
    };

    return (
        <main
            aria-label="Chat"
            data-chat-state={model.selection.kind === "ready" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-background text-foreground max-sm:flex-col sm:flex-row"
            ref={workspace.onAttach}
        >
            {active !== null && (
                <ConversationSidebar
                    botId={active.botId}
                    workspace={workspace}
                    activeId={activeConversationId}
                    optimisticTitles={model.optimisticTitles}
                    projectId={projectId}
                    connectionStatus={connectionStatus}
                    onConnectAgent={setupView?.reason === "unconfigured" ? () => setPairingDialogOpen(true) : null}
                    requests={requests}
                    createTransfer={createTransfer}
                    currentAccessToken={currentAccessToken}
                    onOpen={(session) => openManaged(session.isExternal, session.id)}
                    onOpenSession={(session) =>
                        openManaged(session.result.action === "import", session.result.ready.sessionId)
                    }
                    onNewConversation={newConversation}
                    endRemoteAccess={endRemoteAccess}
                />
            )}
            {model.selection.kind === "ready" && active !== null ? (
                <MobiusSessionPane
                    botId={active.botId}
                    requests={requests}
                    key={model.selection.session.result.ready.sessionId}
                    session={model.selection.session}
                    initialMessage={
                        model.creation.kind === "initial-message-pending" ? model.creation.message : undefined
                    }
                    unconfirmedMessage={
                        model.creation.kind === "initial-message-unconfirmed" ? model.creation.journal : undefined
                    }
                    onInitialMessageDelivered={() =>
                        store.getState().initialMessageDelivered(selectedConversationId(model.selection))
                    }
                    onInitialMessageRecoveryCleared={(commandId) =>
                        store
                            .getState()
                            .initialMessageRecoveryCleared(selectedConversationId(model.selection), commandId)
                    }
                    onInitialMessageUnconfirmed={(commandId) =>
                        store.getState().initialMessageUnconfirmed(selectedConversationId(model.selection), commandId)
                    }
                    onStatusChange={onStatusChange}
                    onTitleChange={store.getState().updateConversationTitle}
                />
            ) : (
                <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <FollowLatestScrollArea
                        container={messageList}
                        followThreshold={80}
                        followRevision={followRevision}
                        className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-4 py-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10 lg:px-12"
                        role="log"
                        aria-label="Messages"
                    >
                        <div className="flex min-h-full flex-col gap-8">
                            {model.selection.kind === "loading" || model.view.kind === "loading" ? (
                                <div className="m-auto">
                                    <Spinner
                                        label={
                                            model.selection.kind === "loading"
                                                ? "Loading session"
                                                : "Connecting to your agent"
                                        }
                                    />
                                </div>
                            ) : model.view.kind === "failed" || model.selection.kind === "failed" ? (
                                <div className="m-auto grid justify-items-center gap-4 text-center">
                                    <p data-testid={dataTestId.sessionLoadFailure} role="alert">
                                        {model.selection.kind === "failed"
                                            ? model.selection.message
                                            : model.view.kind === "failed"
                                              ? model.view.message
                                              : "Chat is unavailable."}
                                    </p>
                                    {model.selection.kind === "failed" &&
                                    model.selection.target.kind === "continue" &&
                                    model.selection.target.action === "import" ? (
                                        <Button onClick={store.getState().forkInstead}>Fork session instead</Button>
                                    ) : (
                                        <div className="flex flex-wrap justify-center gap-2">
                                            <Button onClick={store.getState().retry}>Reconnect</Button>
                                        </div>
                                    )}
                                </div>
                            ) : queuedInitialMessage !== null && creationStatus !== null ? (
                                <div className="mx-auto flex w-full min-w-0 max-w-[920px] flex-col gap-2">
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
                                        className={`text-right text-xs ${creationError.length > 0 ? "text-destructive" : "text-muted-foreground"}`}
                                        data-testid={dataTestId.initialMessageStatus}
                                        role="status"
                                    >
                                        {creationStatus}
                                    </p>
                                    {creationError.length > 0 && (
                                        <p
                                            aria-live="assertive"
                                            className="ml-auto max-w-[85%] rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-right text-xs text-destructive"
                                            role="alert"
                                        >
                                            {creationError}
                                        </p>
                                    )}
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
                                    <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em]">Morty</h1>
                                    <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                        {model.view.kind === "connecting"
                                            ? "Chat is restoring access to this session."
                                            : "Ask a question, explore your project, or start a task with your local agent."}
                                    </p>
                                </div>
                            )}
                        </div>
                    </FollowLatestScrollArea>
                    {model.view.kind === "active" && model.selection.kind === "draft" && (
                        <BotChatComposer
                            attachments={attachments}
                            disabled={composerLocked}
                            draft={draft}
                            error={creationError}
                            onAttachmentsChange={setAttachments}
                            onDraftChange={store.getState().setDraft}
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
                                key={model.selection.key}
                                workspace={workspace}
                                disabled={composerLocked}
                            />
                        </BotChatComposer>
                    )}
                </section>
            )}
            {pairingNotice && setupView?.reason === "unconfigured" && active !== null && (
                <Dialog
                    title="Connect agent"
                    description="Morty is ready. Paste this instruction into your local agent to connect it."
                    onClose={() => {
                        setPairingDialogOpen(false);
                        store.getState().dismissNotice("pairing");
                    }}
                >
                    <PairingInstruction />
                </Dialog>
            )}
            {failureNotice && model.view.kind === "connection-failed" && (
                <Dialog
                    title="Runtime connection unavailable"
                    description={model.view.message}
                    onClose={() => {
                        store.getState().dismissNotice("connection-failed");
                    }}
                    testId={dataTestId.runtimeSetupFailure}
                >
                    <Button
                        onClick={() => {
                            store.getState().dismissNotice("connection-failed");
                            store.getState().retry();
                        }}
                    >
                        Reconnect
                    </Button>
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
                        aria-label="Dismiss disconnected agent notification"
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
