import { MessageSquare, X } from "lucide-react";
import { useStore } from "zustand";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import {
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { ExecutionContextBar } from "../../components/chat/execution-context-bar.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { botConnectionStatus, disconnectedBotNotice } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import {
    conversationComposerLocked,
    conversationCreationBusy,
    conversationCreationError,
    conversationCreationStatus,
    queuedDraftMessage,
} from "../../view-models/chat/conversation-creation-machine.ts";
import { selectedConversationId } from "../../view-models/chat/conversation-selection-machine.ts";
import { pendingExecutionContext } from "../../view-models/chat/execution-context.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { OnlineComputerAlternative } from "./computer-switcher.tsx";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane, MobiusSessionPaneLoading, SessionMessageListSkeleton } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

export function BotChatHome({
    requests,
    workspace,
}: {
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
    readonly workspace: ChatWorkspace;
}) {
    const store = workspace.home;
    const model = useStore(store);
    const draftControls = useStore(workspace.draftControls);
    const executionContext = pendingExecutionContext(model, draftControls.settings);
    const attachmentModel = useStore(model.composerAttachments);
    const connectionStatus = botConnectionStatus(model);
    const disconnectionNotice = disconnectedBotNotice(model.view, connectionStatus);
    const creationBusy = conversationCreationBusy(model.creation);
    const composerLocked = conversationComposerLocked(model.creation);
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const draft = model.draft;
    const setupView = model.view.kind === "setup" ? model.view : null;
    const pairingNotice = model.notices.pairing.kind === "visible" || model.pairingDialogOpen;

    const active =
        model.view.kind === "connecting" ||
        model.view.kind === "active" ||
        model.view.kind === "setup" ||
        model.view.kind === "runtime-disconnected"
            ? model.view
            : null;
    const activeConversationId = selectedConversationId(model.selection);
    const reportButton = (
        <BugReportButton
            appearance="icon"
            daemonSource={{
                botId: workspace.botId,
                sessionId: activeConversationId,
                nativeSessionId: null,
                read: (signal) => requests.daemonDiagnostics(workspace.botId, signal),
                readNetwork: (signal) => requests.networkDiagnostic(workspace.botId, signal),
            }}
            dialog={workspace.bugReportDialog}
        />
    );
    const newConversation = () => {
        store.getState().newConversation();
    };
    const openManaged = (isExternal: boolean, id: string) => {
        store.getState().openManaged(isExternal, id);
    };

    return (
        <main
            aria-label="Chat"
            data-chat-state={model.selection.kind === "ready" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-card/90 text-foreground max-sm:flex-col sm:flex-row sm:bg-sidebar"
            ref={workspace.onAttach}
            onPointerDownCapture={workspace.recordUserActivity}
            onKeyDownCapture={workspace.recordUserActivity}
            onInputCapture={workspace.recordUserActivity}
        >
            {active !== null && (
                <ConversationSidebar
                    botId={active.botId}
                    workspace={workspace}
                    activeId={activeConversationId}
                    connectionStatus={connectionStatus}
                    onConnectAgent={setupView?.reason === "unconfigured" ? store.getState().showPairingDialog : null}
                    requests={requests}
                    onOpen={(session) => openManaged(session.isExternal, session.id)}
                    onNewConversation={newConversation}
                />
            )}
            {workspace.accessNotice !== null && (
                <div
                    role="status"
                    className="fixed bottom-24 left-4 z-[100] rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg"
                >
                    {workspace.accessNotice}
                </div>
            )}
            <section aria-label="Conversation" className={chatSessionPaneSectionClassName}>
                {model.selection.kind === "ready" && active !== null ? (
                    <MobiusSessionPane key={model.selection.session.result.ready.sessionId} workspace={workspace} />
                ) : model.selection.kind === "loading" && active !== null ? (
                    <MobiusSessionPaneLoading
                        executionContext={executionContext}
                        footer={
                            <BotChatComposer
                                attachmentModel={attachmentModel}
                                attachmentSignal={workspace.operationsSignal()}
                                disabled
                                draft=""
                                error=""
                                onDraftChange={() => {}}
                                onStop={() => {}}
                                onSubmit={() => {}}
                                outputState="idle"
                                submitDisabled
                            >
                                {null}
                            </BotChatComposer>
                        }
                    />
                ) : (
                    <>
                        <header className={cn(chatSessionExecutionHeaderClassName, "justify-end")}>
                            <ExecutionContextBar context={executionContext} layout="header" />
                        </header>
                        <FollowLatestScrollArea
                            followThreshold={80}
                            followRevision={model.scrollFollowRevision}
                            className={`flex flex-col gap-8 ${chatSessionMessageScrollClassName}`}
                            role="log"
                            aria-label="Messages"
                        >
                            <div className="flex min-h-full flex-col gap-8">
                                {model.selection.kind === "loading" || model.view.kind === "loading" ? (
                                    <SessionMessageListSkeleton />
                                ) : model.view.kind === "failed" || model.selection.kind === "failed" ? (
                                    <div className="m-auto grid justify-items-center gap-4 text-center">
                                        <div className="flex items-start gap-2">
                                            <SessionLoadFailure
                                                message={
                                                    model.selection.kind === "failed"
                                                        ? model.selection.message
                                                        : model.view.kind === "failed"
                                                          ? model.view.message
                                                          : "Chat is unavailable."
                                                }
                                            />
                                            {reportButton}
                                        </div>
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
                                    <div className={`${chatSessionColumnClassName} flex flex-col gap-2`}>
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
                                            <div
                                                aria-live="assertive"
                                                className="ml-auto flex max-w-[85%] items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-right text-xs text-destructive"
                                                role="alert"
                                            >
                                                <span className="min-w-0 flex-1 break-words">{creationError}</span>
                                                {reportButton}
                                            </div>
                                        )}
                                    </div>
                                ) : active === null ? null : (
                                    <div
                                        className="m-auto max-w-lg px-6 text-center"
                                        data-testid={dataTestId.chatLanding}
                                    >
                                        <span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[18px] bg-primary-subtle text-primary shadow-[inset_0_0_0_1px_rgba(34,123,78,0.08)]">
                                            <MessageSquare className="size-6" aria-hidden="true" />
                                        </span>
                                        <h1 className="text-[18px] leading-6 font-semibold tracking-[-0.025em]">
                                            Morty
                                        </h1>
                                        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                            {model.view.kind === "connecting"
                                                ? "Chat is restoring access to this session."
                                                : "Ask a question, explore your project, or start a task with your local agent."}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </FollowLatestScrollArea>
                        {model.runtimeConfiguration !== null && model.selection.kind === "draft" && (
                            <BotChatComposer
                                attachmentModel={attachmentModel}
                                attachmentSignal={workspace.operationsSignal()}
                                disabled={composerLocked}
                                draft={draft}
                                error={creationError}
                                errorStatus={creationError.length > 0 ? reportButton : undefined}
                                onDraftChange={store.getState().setDraft}
                                onStop={() => {}}
                                onSubmit={() => {
                                    void store.getState().createConversation(workspace.chatSignal());
                                }}
                                outputState="idle"
                                submitDisabled={
                                    model.view.kind !== "active" ||
                                    creationBusy ||
                                    (draft.trim().length === 0 && attachmentModel.attachments.length === 0) ||
                                    model.draftSettings === null
                                }
                            >
                                <DraftChatControls
                                    key={model.selection.key}
                                    workspace={workspace}
                                    disabled={composerLocked || model.view.kind !== "active"}
                                />
                            </BotChatComposer>
                        )}
                    </>
                )}
            </section>
            {pairingNotice && setupView?.reason === "unconfigured" && active !== null && (
                <Dialog
                    appearance="setup"
                    title="Connect agent"
                    description="Morty is ready. Paste this instruction into your local agent to connect it."
                    onClose={() => {
                        store.getState().closePairingDialog();
                        store.getState().dismissNotice();
                    }}
                >
                    <PairingInstruction />
                </Dialog>
            )}
            {disconnectionNotice.kind === "visible" && !model.disconnectedNoticeDismissed && (
                <div
                    aria-live="polite"
                    className="fixed top-28 right-4 z-[100] grid w-[calc(100%-2rem)] max-w-sm grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg border border-border bg-background p-2 text-sm text-foreground shadow-lg sm:top-6 sm:right-6"
                    role="status"
                >
                    <div className="min-w-0 py-2 pl-2">
                        <p className="font-semibold">{disconnectionNotice.title}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {disconnectionNotice.description}
                        </p>
                        {workspace.computers !== null && <OnlineComputerAlternative model={workspace.computers} />}
                    </div>
                    <button
                        aria-label="Dismiss disconnected agent notification"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70"
                        onClick={store.getState().dismissDisconnectedNotice}
                        type="button"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            )}
        </main>
    );
}
