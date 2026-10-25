import { MessageSquare } from "lucide-react";
import { useStore } from "zustand";
import { BotChatComposer } from "../../components/chat/bot-chat-composer.tsx";
import {
    chatSessionColumnClassName,
    chatSessionExecutionHeaderClassName,
    chatSessionMessageScrollClassName,
    chatSessionPaneEnterClassName,
    chatSessionPaneSectionClassName,
} from "../../components/chat/chat-session-layout.ts";
import { ConnectionNotice } from "../../components/chat/connection-notice.tsx";
import { CwdSelector } from "../../components/chat/cwd-selector.tsx";
import { HarnessMark } from "../../components/chat/harness-mark.tsx";
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
import { botConnectionStatus } from "../../view-models/chat/bot-chat-home-store.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
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
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { OnlineComputerAlternative } from "./computer-switcher.tsx";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane, MobiusSessionPaneLoading, SessionMessageListSkeleton } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

type BotChatHomeProps = {
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
    if (settingsKind === "loading") {
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
}: {
    readonly agentLabel: string;
    readonly agentRef: string;
    readonly centered: boolean;
}) {
    return (
        <h2
            className={cn(
                "flex min-w-0 items-center gap-2 text-sm font-semibold",
                centered && "w-full max-w-full justify-center",
            )}
            title="New Session"
        >
            <HarnessMark
                agentRef={agentRef || agentLabel}
                appearance="line"
                className="text-copy-secondary"
                label={agentLabel}
                testId={dataTestId.sessionTitleHarnessMark}
            />
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
    const creationError = conversationCreationError(model.creation);
    const creationStatus = conversationCreationStatus(model.creation);
    const queuedInitialMessage = queuedDraftMessage(model.creation);
    const draft = model.draft;
    const pendingConversation = pendingConversationPresentation(model);
    const setupView = model.view.kind === "setup" ? model.view : null;
    const pairingNotice = model.notices.pairing.kind === "visible" || model.pairingDialogOpen;

    const active =
        model.view.kind === "connecting" ||
        model.view.kind === "active" ||
        model.view.kind === "setup" ||
        model.view.kind === "runtime-disconnected"
            ? model.view
            : null;
    const newSessionHarness = activeHarnessMark(model, draftControls.settings);
    const showNewSessionTitle = model.selection.kind === "draft";
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
    const pendingTitle = showNewSessionTitle ? (
        <NewSessionTitle
            agentLabel={newSessionHarness.label}
            agentRef={newSessionHarness.agentRef}
            centered={!desktop}
        />
    ) : (
        <h2 className="min-w-0 truncate text-sm font-semibold">{pendingConversation.title}</h2>
    );

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
            <ConversationSidebar
                botId={workspace.botId}
                workspace={workspace}
                activeId={activeConversationId}
                connectionStatus={connectionStatus}
                onConnectAgent={setupView?.reason === "unconfigured" ? store.getState().showPairingDialog : null}
                requests={requests}
                onOpen={(session) => openManaged(session.isExternal, session.id)}
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
                {model.selection.kind === "ready" && active !== null ? (
                    <div className={chatSessionPaneEnterClassName} key={model.selection.session.result.ready.sessionId}>
                        <MobiusSessionPane workspace={workspace} />
                    </div>
                ) : model.selection.kind === "loading" && active !== null && pendingConversation.recovery === null ? (
                    <MobiusSessionPaneLoading
                        title={pendingConversation.title}
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
                                ) : model.selection.kind === "loading" || model.view.kind === "loading" ? (
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
                                    <div className="m-auto flex max-w-lg flex-col items-center px-6">
                                        <div className="text-center" data-testid={dataTestId.chatLanding}>
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
                                        {model.view.kind === "active" && model.selection.kind === "draft" && (
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
                                attachmentSignal={workspace.operationsSignal()}
                                disabled={composerLocked}
                                draft={draft}
                                error={creationError}
                                errorStatus={
                                    creationError.length > 0 ? (
                                        reportButton
                                    ) : executionContext.feedback.kind === "hidden" ? undefined : (
                                        <div className="w-full">
                                            <ConnectionNotice
                                                feedback={executionContext.feedback}
                                                onRetryNow={store.getState().retry}
                                                onReopen={store.getState().retry}
                                            />
                                            {workspace.computers !== null && (
                                                <OnlineComputerAlternative model={workspace.computers} />
                                            )}
                                        </div>
                                    )
                                }
                                onDraftChange={store.getState().setDraft}
                                onStop={() => {}}
                                onSubmit={() => {
                                    void store.getState().createConversation(workspace.operationsSignal());
                                }}
                                outputState="idle"
                                submitDisabled={
                                    !executionContext.available ||
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
        </main>
    );
}
