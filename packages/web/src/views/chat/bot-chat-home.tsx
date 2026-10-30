import type { ReactNode } from "react";
import { useStore } from "zustand";
import { MortyLogoMark } from "../../components/brand/morty-logo.tsx";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import {
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneEnterClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { ComputerOfflineIcon } from "../../components/chat/computer-offline-icon.tsx";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { CwdSelector } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
import { MessageDeliveryStatus } from "../../components/chat/message-delivery-status.tsx";
import { MobileSessionTitlePortal } from "../../components/chat/mobile-session-title-portal.tsx";
import { SessionLoadFailure } from "../../components/chat/session-load-failure.tsx";
import { UserPromptMessage } from "../../components/chat/user-prompt-message.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { FollowLatestScrollArea } from "../../components/utils/follow-latest-scroll-area.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import { botConnectionStatus, homeCanStartConversation } from "../../view-models/chat/bot-chat-home-store.ts";
import { chatDiagnostics } from "../../view-models/chat/chat-diagnostics.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { canAddAttachments } from "../../view-models/chat/composer-attachment-store.ts";
import {
    conversationComposerLocked,
    conversationCreationBusy,
    conversationCreationError,
    conversationCreationStatus,
    queuedDraftMessage,
} from "../../view-models/chat/conversation-creation-machine.ts";
import { selectedConversationId } from "../../view-models/chat/conversation-selection-machine.ts";
import type { DraftControlsStore } from "../../view-models/chat/draft-controls-store.ts";
import { activeHarnessMark, pendingExecutionContext } from "../../view-models/chat/execution-context.ts";
import { pendingConversationPresentation } from "../../view-models/chat/pending-conversation-presentation.ts";
import { reportApplicationError } from "../../view-models/report-error.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { OnlineComputerAlternative } from "./computer-switcher.tsx";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane, MobiusSessionPaneLoading, SessionMessageListSkeleton } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

/** The centered pre-session failure block: card, grouped action buttons and the report entry. */
function PreSessionFailure({
    action,
    message,
    report,
}: {
    readonly action: ReactNode;
    readonly message: string;
    readonly report: ReactNode;
}) {
    return (
        <div className="m-auto grid justify-items-center gap-4 text-center">
            <SessionLoadFailure message={message} />
            {/* The recovery and report buttons form one group: stacked, with the group's 8px rhythm. */}
            <div className="grid justify-items-center gap-2">
                {action}
                {report}
            </div>
        </div>
    );
}

type BotChatHomeProps = {
    readonly requests: Pick<
        BotChatApi,
        | "readBot"
        | "access"
        | "archiveManagedSession"
        | "runtimeConfiguration"
        | "directory"
        | "readRuntimeBinding"
        | "waitForRuntimeBindingChange"
        | "waitForRuntimeConfigurationChange"
        | "nativeSessions"
        | "nativeSession"
        | "managedSessions"
        | "managedSession"
        | "subscribeManagedSessionStatuses"
        | "connectSession"
        | "createConversation"
        | "conversationSession"
        | "agentSettings"
        | "daemonDiagnostics"
        | "networkDiagnostic"
    >;
    readonly workspace: ChatWorkspace;
};

function DraftLandingDirectory({
    disabled,
    settingsKind,
    signal,
    viewModel,
}: {
    readonly disabled: boolean;
    readonly settingsKind: DraftControlsStore["settings"]["kind"];
    readonly signal: AbortSignal;
    readonly viewModel: DraftControlsStore;
}) {
    if (settingsKind === "loading" || settingsKind === "waiting-agent") {
        return (
            <div
                aria-hidden="true"
                className="mt-5 h-9 w-[140px] animate-pulse rounded-lg bg-morty-fill-opacity-3 motion-reduce:animate-none"
            />
        );
    }
    if (settingsKind !== "ready") {
        return null;
    }
    return (
        <div className="mt-5">
            <CwdSelector disabled={disabled} signal={signal} viewModel={viewModel} />
        </div>
    );
}

function NewSessionTitle({
    agentLabel,
    agentRef,
    centered,
    loading,
}: {
    readonly agentLabel: string;
    readonly agentRef: string;
    readonly centered: boolean;
    readonly loading: boolean;
}) {
    return (
        <h2
            className={cn(
                "flex min-w-0 items-center gap-2 text-sm font-semibold",
                centered && "w-full max-w-full justify-center",
            )}
            title="New Session"
        >
            {centered ? null : (
                <HarnessMark
                    agentRef={agentRef || agentLabel}
                    appearance="line"
                    className="text-copy-secondary"
                    label={agentLabel}
                    loading={loading}
                    testId={dataTestId.sessionTitleHarnessMark}
                />
            )}
            <span className={cn("min-w-0 truncate", centered && "text-center")}>New Session</span>
        </h2>
    );
}

/** The chat home renders its desktop or compact layout as the viewport allows. */
export function BotChatHome(props: BotChatHomeProps) {
    return <DesktopChatLayout>{(desktop) => <BotChatHomeLayout {...props} desktop={desktop} />}</DesktopChatLayout>;
}

function BotChatHomeLayout({ requests, workspace, desktop }: BotChatHomeProps & { readonly desktop: boolean }) {
    const store = workspace.home;
    const model = useStore(store);
    const draftControls = useStore(workspace.draftControls);
    const executionContext = pendingExecutionContext(model, draftControls.settings);
    const attachmentModel = useStore(model.composerAttachments);
    const connectionStatus = botConnectionStatus(model);
    const creationBusy = conversationCreationBusy(model.creation);
    const composerLocked = conversationComposerLocked(model.creation);
    // Leaving the page cancels creation with the workspace; only other failures are unexpected.
    const createConversation = () => {
        const signal = workspace.operationsSignal();
        void store
            .getState()
            .createConversation(signal)
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "conversation-creation");
                }
            });
    };
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const draft = model.draft;
    const titles = useStore(workspace.titles, (state) => state.titles);
    const pendingConversation = pendingConversationPresentation(model, titles);
    const canStartConversation = homeCanStartConversation(model);
    const pairingNotice = model.notices.pairing.kind === "visible" || model.pairingDialogOpen;

    const newSessionHarness = activeHarnessMark(model, draftControls.settings);
    const newSessionHarnessLoading =
        draftControls.settings.kind === "loading" ||
        draftControls.settings.kind === "waiting-agent" ||
        draftControls.settings.kind === "switching";
    const showNewSessionTitle = model.selection.kind === "draft";
    const activeConversationId = selectedConversationId(model.selection);
    const sessionDiagnostics: DaemonDiagnosticsSource = {
        botId: workspace.botId,
        sessionId: activeConversationId,
        nativeSessionId: null,
        context: () => chatDiagnostics(workspace),
        read: (signal) => requests.daemonDiagnostics(workspace.botId, signal),
        readNetwork: (signal) => requests.networkDiagnostic(workspace.botId, signal),
    };
    const reportButton = (
        <BugReportButton appearance="icon" daemonSource={sessionDiagnostics} dialog={workspace.bugReportDialog} />
    );
    // Centered failure cards keep every row on the midline, so their report entry is a
    // labelled tertiary action below the recovery actions instead of an inline icon.
    const reportEntry = (
        <BugReportButton appearance="labelled" daemonSource={sessionDiagnostics} dialog={workspace.bugReportDialog} />
    );
    const newConversation = () => {
        store.getState().newConversation();
    };
    const openManaged = (id: string) => {
        store.getState().openManaged(id);
    };
    const pendingTitle = showNewSessionTitle ? (
        <NewSessionTitle
            agentLabel={newSessionHarness.label}
            agentRef={newSessionHarness.agentRef}
            centered={!desktop}
            loading={newSessionHarnessLoading}
        />
    ) : (
        <h2 className="min-w-0 truncate text-sm font-semibold">{pendingConversation.title}</h2>
    );

    return (
        <main
            aria-label="Chat"
            data-chat-state={model.selection.kind === "ready" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-card/90 text-foreground max-sm:flex-col sm:flex-row sm:bg-sidebar"
            onPointerDownCapture={workspace.recordUserActivity}
            onKeyDownCapture={workspace.recordUserActivity}
            onInputCapture={workspace.recordUserActivity}
        >
            <ConversationSidebar
                botId={workspace.botId}
                workspace={workspace}
                activeId={activeConversationId}
                connectionStatus={connectionStatus}
                onConnectAgent={model.pairing.kind === "unpaired" ? store.getState().showPairingDialog : null}
                requests={requests}
                onOpen={(session) => openManaged(session.id)}
                onNewConversation={newConversation}
            />
            {workspace.accessNotice !== null && (
                <div
                    role="status"
                    className="fixed bottom-24 left-4 z-[100] rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-lg"
                >
                    {workspace.accessNotice}
                </div>
            )}
            <section aria-label="Conversation" className={chatSessionPaneSectionClassName}>
                {model.selection.kind === "ready" ? (
                    <div className={chatSessionPaneEnterClassName} key={model.selection.session.result.ready.sessionId}>
                        <MobiusSessionPane workspace={workspace} />
                    </div>
                ) : (model.selection.kind === "loading" ||
                      (model.selection.kind === "pending" && model.initialization.kind === "loading")) &&
                  pendingConversation.recovery === null ? (
                    <MobiusSessionPaneLoading
                        footer={
                            <BotChatComposer
                                attachmentModel={attachmentModel}
                                focusScope={workspace}
                                canAttach={canAddAttachments(attachmentModel)}
                                attachmentSignal={workspace.operationsSignal()}
                                disabled
                                draft=""
                                error=""
                                onDraftChange={() => {}}
                                onStop={() => {}}
                                onSubmit={() => {}}
                                outputState={creationBusy ? "sending" : "idle"}
                                submitDisabled
                            >
                                {null}
                            </BotChatComposer>
                        }
                    />
                ) : (
                    <>
                        {desktop ? (
                            <header className={cn(chatSessionExecutionHeaderClassName, "justify-between")}>
                                {pendingTitle}
                            </header>
                        ) : (
                            <MobileSessionTitlePortal>{pendingTitle}</MobileSessionTitlePortal>
                        )}
                        <FollowLatestScrollArea
                            followThreshold={80}
                            followRevision={model.scrollFollowRevision}
                            className={`flex flex-col gap-8 ${chatSessionMessageScrollClassName}`}
                            role="log"
                            aria-label="Messages"
                        >
                            <div className="flex min-h-full flex-col gap-8">
                                {pendingConversation.recovery !== null ? (
                                    <div className="m-auto grid max-w-lg justify-items-center gap-4 px-6 text-center">
                                        <ComputerOfflineIcon />
                                        <div role="status" aria-live="polite" aria-atomic="true">
                                            <p className="font-medium">{pendingConversation.recovery.title}</p>
                                            <p className="mt-2 text-sm text-muted-foreground">
                                                {pendingConversation.recovery.description}
                                            </p>
                                            <p className="mt-2 text-sm text-muted-foreground">
                                                Your unsent draft will be restored with this session.
                                            </p>
                                        </div>
                                        <Button onClick={store.getState().retry}>Reconnect</Button>
                                    </div>
                                ) : model.selection.kind === "loading" || model.initialization.kind === "loading" ? (
                                    <SessionMessageListSkeleton />
                                ) : model.initialization.kind === "failed" || model.selection.kind === "failed" ? (
                                    <PreSessionFailure
                                        action={<Button onClick={store.getState().retry}>Reconnect</Button>}
                                        message={
                                            model.selection.kind === "failed"
                                                ? model.selection.message
                                                : model.initialization.kind === "failed"
                                                  ? model.initialization.message
                                                  : "Chat is unavailable."
                                        }
                                        report={reportEntry}
                                    />
                                ) : queuedInitialMessage !== null && creationStatus !== null ? (
                                    <div className={`${chatSessionColumnClassName} flex flex-col gap-2`}>
                                        <div data-testid={dataTestId.queuedMessage}>
                                            <UserPromptMessage
                                                attachments={queuedInitialMessage.attachments}
                                                status={
                                                    <MessageDeliveryStatus
                                                        data-testid={dataTestId.initialMessageStatus}
                                                        delivery={creationBusy ? "sending" : "failed"}
                                                        label={creationStatus}
                                                    />
                                                }
                                                text={queuedInitialMessage.content}
                                            />
                                        </div>
                                        {creationError.length > 0 && (
                                            <div
                                                aria-live="assertive"
                                                className="ml-auto flex max-w-[85%] items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-right text-xs text-destructive"
                                                role="alert"
                                            >
                                                <span className="min-w-0 flex-1 break-words">{creationError}</span>
                                                <Button onClick={createConversation}>Retry message</Button>
                                                {reportButton}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="m-auto flex max-w-lg flex-col items-center px-6">
                                        <div className="text-center" data-testid={dataTestId.chatLanding}>
                                            <MortyLogoMark className="mx-auto mb-5 block" size={56} />
                                            <h1 className="text-[18px] leading-6 font-semibold tracking-[-0.025em]">
                                                Morty
                                            </h1>
                                            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                                Ask a question, explore your project, or start a task with your local
                                                agent.
                                            </p>
                                        </div>
                                        {canStartConversation && model.selection.kind === "draft" && (
                                            <DraftLandingDirectory
                                                disabled={composerLocked}
                                                settingsKind={draftControls.settings.kind}
                                                signal={workspace.chatSignal()}
                                                viewModel={draftControls}
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        </FollowLatestScrollArea>
                        {model.runtimeConfiguration !== null && model.selection.kind === "draft" && (
                            <BotChatComposer
                                attachmentModel={attachmentModel}
                                focusScope={workspace}
                                canAttach={canAddAttachments(attachmentModel)}
                                attachmentSignal={workspace.operationsSignal()}
                                disabled={false}
                                draft={draft}
                                error=""
                                errorStatus={
                                    executionContext.feedback.kind === "hidden" ? undefined : (
                                        <ConnectionNotice
                                            feedback={executionContext.feedback}
                                            footer={
                                                workspace.computers === null ? undefined : (
                                                    <OnlineComputerAlternative model={workspace.computers} />
                                                )
                                            }
                                            onRetryNow={store.getState().retry}
                                            onReopen={store.getState().retry}
                                        />
                                    )
                                }
                                onDraftChange={store.getState().setDraft}
                                onStop={() => {}}
                                onSubmit={createConversation}
                                outputState={creationBusy ? "sending" : "idle"}
                                submitDisabled={
                                    !executionContext.available ||
                                    !canStartConversation ||
                                    composerLocked ||
                                    (draft.trim().length === 0 && attachmentModel.attachments.length === 0) ||
                                    draftControls.settings.kind !== "ready"
                                }
                            >
                                <DraftChatControls
                                    key={model.selection.key}
                                    workspace={workspace}
                                    disabled={composerLocked || !canStartConversation}
                                />
                            </BotChatComposer>
                        )}
                    </>
                )}
            </section>
            {pairingNotice && model.pairing.kind === "unpaired" && (
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
        </main>
    );
}
