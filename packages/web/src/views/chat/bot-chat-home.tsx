import { MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { BotChatComposer, type ComposerAttachment } from "../../components/chat/bot-chat-composer.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { createBotChatHomeStore, setupDescription } from "../../view-models/chat/bot-chat-home-store.ts";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane } from "./mobius-session-pane.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

export function BotChatHome({
    requests,
    createTransfer,
    endRemoteAccess,
}: {
    readonly requests: Pick<
        BotChatApi,
        | "listBots"
        | "access"
        | "workspace"
        | "workspaceDirectory"
        | "waitForWorkspaceChange"
        | "selectAgent"
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
        }),
    );
    const model = useStore(store);
    const [draft, setDraft] = useState("");
    const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
    const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
    const lifetime = useRef<AbortController | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const messageContent = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    const [remoteAccess] = useState(() => new URL(window.location.href).searchParams.get("remoteAccess") === "1");

    // biome-ignore lint/correctness/useExhaustiveDependencies: Store revision explicitly restarts route loading.
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void store.getState().load(controller.signal);
        return () => {
            controller.abort();
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [model.revision, store]);

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

    const active = model.view.kind === "switching" ? model.view.view : model.view.kind === "draft" ? model.view : null;
    const switching = model.view.kind === "switching";
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
                    activeId={
                        model.target.kind === "conversation-access"
                            ? model.target.conversationId
                            : model.target.kind === "session-access"
                              ? model.target.sessionId
                              : ""
                    }
                    botId={active.bot.botId}
                    requests={requests}
                    createTransfer={createTransfer}
                    onOpen={(session) => openManaged(session.kind, session.id)}
                    onOpenSession={(session) => openManaged(session.result.action, session.result.ready.sessionId)}
                    onNewConversation={newConversation}
                />
            )}
            {model.sessionView.kind === "session-access" && active !== null ? (
                <MobiusSessionPane
                    botId={active.bot.botId}
                    requests={requests}
                    key={model.sessionView.session.result.ready.sessionId}
                    session={model.sessionView.session}
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
                            {model.view.kind === "loading" || model.view.kind === "switching" ? (
                                <div className="m-auto">
                                    <Spinner
                                        label={
                                            model.view.kind === "switching"
                                                ? "Switching session"
                                                : "Connecting to your agent"
                                        }
                                    />
                                </div>
                            ) : model.view.kind === "setup" ? (
                                <section className="m-auto w-full max-w-lg animate-cloud-enter rounded-2xl border border-border bg-card p-8 shadow-sm motion-reduce:animate-none">
                                    <MessageSquare className="mb-5 size-8 text-primary" aria-hidden="true" />
                                    <h1 className="text-2xl font-semibold tracking-tight">
                                        {model.view.reason === "unconfigured"
                                            ? "Your Chat is ready to connect"
                                            : "Chat is waiting to reconnect"}
                                    </h1>
                                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                        {setupDescription(model.view.reason)}
                                    </p>
                                    <PairingInstruction requests={requests} />
                                    <p role="status" className="mt-4 text-sm text-muted-foreground">
                                        Chat will open when the server reports that this Bot is active and its selected
                                        agent is online.
                                    </p>
                                </section>
                            ) : model.view.kind === "failed" ? (
                                <div className="m-auto grid justify-items-center gap-4 text-center">
                                    <p role="alert">{model.view.message}</p>
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
                                    {pairingDialogOpen && (
                                        <Dialog
                                            title="Pair agent again"
                                            description="Paste this one-time instruction into your local agent, then return here after it connects."
                                            onClose={() => setPairingDialogOpen(false)}
                                        >
                                            <PairingInstruction requests={requests} />
                                        </Dialog>
                                    )}
                                </div>
                            ) : active === null ? null : (
                                <div className="m-auto max-w-lg px-6 text-center">
                                    <span className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[18px] bg-primary-subtle text-primary shadow-[inset_0_0_0_1px_rgba(34,123,78,0.08)]">
                                        <MessageSquare className="size-6" aria-hidden="true" />
                                    </span>
                                    <p className="mb-2 text-[11px] font-semibold tracking-[0.1em] text-primary uppercase">
                                        Ready to collaborate
                                    </p>
                                    <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em]">
                                        {active.bot.displayName}
                                    </h1>
                                    <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                                        Ask a question, explore the workspace, or start a task with your local agent.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                    {active !== null && !switching && (
                        <BotChatComposer
                            attachments={attachments}
                            disabled={model.submission.kind === "sending"}
                            draft={draft}
                            error={model.submission.kind === "failed" ? model.submission.message : ""}
                            onAttachmentsChange={setAttachments}
                            onDraftChange={setDraft}
                            onStop={() => {}}
                            onSubmit={() => void send()}
                            outputState="idle"
                            submitDisabled={
                                model.submission.kind === "sending" ||
                                (draft.trim().length === 0 && attachments.length === 0) ||
                                model.draftSettings === null
                            }
                        >
                            <DraftChatControls
                                key={model.target.kind === "draft" ? model.target.key : "existing"}
                                botId={active.bot.botId}
                                requests={requests}
                                disabled={model.submission.kind === "sending"}
                                onSettings={store.getState().setDraftSettings}
                            />
                        </BotChatComposer>
                    )}
                </section>
            )}
        </main>
    );
}
