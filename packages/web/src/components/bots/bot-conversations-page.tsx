import type { MobiusMessage } from "@moxt-ai/mobius-sdk";
import {
    ArrowLeft,
    Bot,
    FileText,
    Image as ImageIcon,
    LoaderCircle,
    LockKeyhole,
    MessageSquare,
    Paperclip,
    Plus,
    RefreshCw,
    Send,
    Square,
    X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { useStore } from "zustand";
import { AgentMarkdown } from "@/components/agents/agent-markdown";
import { BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { SessionConfigControlsView } from "@/components/chat/session-config-controls";
import { UserPromptMessage } from "@/components/chat/user-prompt-message";
import { WorkspacePickerControl } from "@/components/chat/workspace-picker";
import { Button } from "@/components/ui/button";
import { botConversationRoutePath, botConversationsRoutePath } from "@/services/application/app-routes";
import { listWorkspace } from "@/services/chat/mobius-transport";
import { createConversationComposerStore } from "@/view-models/bots/conversation-composer-store";
import {
    botConversationTitle,
    createBotConversationDirectoryStore,
    formatBotConversationDate,
} from "@/view-models/bots/conversation-directory-store";
import { createConversationSessionStore } from "@/view-models/bots/conversation-session-store";
import { createConversationThreadStore } from "@/view-models/bots/conversation-thread-store";

const BOT_COMPOSER_MAX_HEIGHT = 180;

export function BotConversationsPage() {
    const { bot, client, connection, signal } = useOutletContext<BotDetailContext>();
    const navigate = useNavigate();
    const errorSummaryRef = useRef<HTMLDivElement>(null);
    const [store] = useState(() =>
        createBotConversationDirectoryStore(bot.botId, client, async (conversationId) => {
            await navigate(botConversationRoutePath(connection.channelId, bot.botId, conversationId));
        }),
    );
    const viewModel = useStore(store);
    const { creating, error: formError, state } = viewModel;

    useEffect(() => {
        void viewModel.load(signal);
    }, [signal, viewModel.load]);

    useEffect(() => {
        if (formError.length > 0) {
            queueMicrotask(() => errorSummaryRef.current?.focus());
        }
    }, [formError]);

    const canCreate = bot.state.kind === "active";
    return (
        <div className="mx-auto w-full max-w-[920px] px-5 py-7 sm:px-8 sm:py-9">
            <section aria-labelledby="bot-conversations-heading">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="max-w-2xl">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Durable Sessions
                        </p>
                        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]" id="bot-conversations-heading">
                            Conversations
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            Each conversation stays pinned to the behavior and execution-binding revision active when it
                            was created.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            aria-busy={state.kind === "loading"}
                            aria-label="Refresh conversations"
                            className="size-11 shrink-0"
                            disabled={state.kind === "loading"}
                            onClick={() => void viewModel.load(signal)}
                            size="icon"
                            variant="ghost"
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={state.kind === "loading" ? "size-4 animate-spin" : "size-4"}
                            />
                        </Button>
                        <Button
                            aria-busy={creating}
                            className="min-h-11 shrink-0"
                            disabled={!canCreate || creating}
                            onClick={() => void viewModel.createConversation(signal)}
                        >
                            {creating ? (
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-4 animate-spin motion-reduce:animate-none"
                                />
                            ) : (
                                <Plus aria-hidden="true" className="size-4" />
                            )}
                            New chat
                        </Button>
                    </div>
                </div>
                {!canCreate && (
                    <p className="mt-4 rounded-xl border border-[#f2d39b] bg-[#fffaf0] px-4 py-3 text-xs leading-5 text-[#7b4c00]">
                        Activate this Bot before creating a conversation. Suspended and archived Bots keep their history
                        but do not accept new turns.
                    </p>
                )}
                {formError.length > 0 && (
                    <div
                        className="mt-4 rounded-lg border border-[#f2c4c4] bg-[#fff7f7] px-3 py-2 text-sm text-[#9b2c32] outline-none"
                        ref={errorSummaryRef}
                        role="alert"
                        tabIndex={-1}
                    >
                        {formError}
                    </div>
                )}
            </section>

            <section aria-label="Bot conversation directory" className="mt-8">
                {state.kind === "loading" && (
                    <div
                        aria-busy="true"
                        className="flex min-h-24 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 text-sm text-muted-foreground"
                    >
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading conversations…
                    </div>
                )}
                {state.kind === "failed" && (
                    <div className="rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-4">
                        <BotInlineError>{state.message}</BotInlineError>
                        <Button className="mt-3 min-h-11" onClick={() => void viewModel.load(signal)} variant="outline">
                            <RefreshCw aria-hidden="true" className="size-4" /> Retry
                        </Button>
                    </div>
                )}
                {state.kind === "ready" && state.conversations.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-black/15 bg-white/60 px-6 py-10 text-center">
                        <MessageSquare aria-hidden="true" className="mx-auto size-6 text-[#218854]" />
                        <p className="mt-3 text-sm font-semibold">No conversations yet</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Start one after the Bot has an approved execution binding.
                        </p>
                    </div>
                )}
                {state.kind === "ready" && state.conversations.length > 0 && (
                    <ul aria-label="Bot conversations" className="grid gap-2">
                        {state.conversations.map((conversation) => (
                            <li key={conversation.conversationId}>
                                <Link
                                    className="flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-4 py-3 text-foreground no-underline shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-colors hover:border-black/16 hover:bg-black/[0.012] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                                    to={botConversationRoutePath(
                                        connection.channelId,
                                        bot.botId,
                                        conversation.conversationId,
                                    )}
                                >
                                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                                        <MessageSquare aria-hidden="true" className="size-4" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <strong className="block truncate text-sm font-semibold">
                                            {botConversationTitle(conversation)}
                                        </strong>
                                        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                            {conversation.origin.kind === "owner"
                                                ? "Owner conversation"
                                                : "External connection"}
                                            {" · "}
                                            {formatBotConversationDate(conversation.createdAt)}
                                        </span>
                                    </span>
                                    <span className="rounded-full bg-black/5 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                                        {conversation.state.kind}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function ConversationMessage({ botName, message }: { readonly botName: string; readonly message: MobiusMessage }) {
    const running =
        message.attempt.kind === "none" ||
        message.attempt.kind === "dispatching" ||
        message.attempt.kind === "running" ||
        message.attempt.kind === "waiting_input";
    return (
        <li className="contents">
            <UserPromptMessage images={message.images} resources={message.resources} text={message.prompt} />
            <article aria-label={`Message from ${botName}`} className="mb-9 min-w-0">
                {message.response.length > 0 ? (
                    <div className="agent-stream min-w-0">
                        <AgentMarkdown markdown={message.response} streaming={running} />
                    </div>
                ) : running ? (
                    <div
                        aria-label={`${botName} is working`}
                        className="thinking-indicator mt-1.5 inline-flex h-6 items-center gap-1"
                        role="status"
                    >
                        <span />
                        <span />
                        <span />
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">No response was recorded for this turn.</p>
                )}
                {message.attempt.kind === "failed" && (
                    <p className="mt-2 text-xs text-[#9b2c32]">
                        The turn failed before a complete response was recorded.
                    </p>
                )}
                {message.attempt.kind === "cancelled" && (
                    <p className="mt-2 text-xs text-muted-foreground">This turn was cancelled.</p>
                )}
            </article>
        </li>
    );
}

export function BotConversationPage() {
    const { bot, client, connection, signal } = useOutletContext<BotDetailContext>();
    const params = useParams<"conversationId">();
    const conversationId = params.conversationId ?? "";
    const [threadStore] = useState(() => createConversationThreadStore(bot.botId, conversationId, client, connection));
    const [sessionStore] = useState(() => createConversationSessionStore(connection));
    const [composerStore] = useState(() =>
        createConversationComposerStore(bot.botId, bot.displayName, client, connection, threadStore, sessionStore),
    );
    const thread = useStore(threadStore);
    const sessionViewModel = useStore(sessionStore);
    const composer = useStore(composerStore);
    const { announcement, cancelling, loadingEarlier, operationError, optimisticPrompt, state } = thread;
    const { configuring, state: composerSession } = sessionViewModel;
    const { attaching, draft, images: draftImages, resources: draftResources, submitting } = composer;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        void thread.open(signal);
    }, [signal, thread.open]);

    const ready = state.kind === "ready" ? state : undefined;
    const turnRunning = ready?.turn.kind === "running" || ready?.turn.kind === "running-without-identifier";
    const readySessionId =
        ready !== undefined && ready.conversation.origin.kind === "owner" ? ready.conversation.sessionId : "";

    useEffect(() => {
        if (readySessionId.length > 0) {
            void sessionViewModel.prepare(readySessionId, signal);
        }
    }, [readySessionId, sessionViewModel.prepare, signal]);

    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (textarea === null) {
            return;
        }
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, BOT_COMPOSER_MAX_HEIGHT).toString()}px`;
    });

    if (state.kind === "loading") {
        return (
            <div
                aria-busy="true"
                className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"
            >
                <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> Loading conversation…
            </div>
        );
    }
    if (state.kind === "failed") {
        return (
            <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
                <Link
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground no-underline hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    to={botConversationsRoutePath(connection.channelId, bot.botId)}
                >
                    <ArrowLeft aria-hidden="true" className="size-4" /> Conversations
                </Link>
                <div className="mt-5 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-5">
                    <BotInlineError>{state.message}</BotInlineError>
                    <Button className="mt-3 min-h-11" onClick={() => void thread.load(signal)} variant="outline">
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            </div>
        );
    }
    if (ready === undefined) {
        return null;
    }
    const cancellableTurn = ready.turn.kind === "running" ? ready.turn : undefined;
    const preparedComposer = composerSession.kind === "ready" ? composerSession : undefined;
    const preparedFailure =
        composerSession.kind === "failed" || composerSession.kind === "prepared-failed" ? composerSession.message : "";
    const composerDirectoryId =
        preparedComposer?.session.defaultBinding.workspaceRef ??
        (composerSession.kind === "prepared-failed" ? composerSession.session.defaultBinding.workspaceRef : "default");
    const composerDirectoryLabel =
        preparedComposer?.ready.directoryLabel ??
        (composerSession.kind === "preparing" || composerSession.kind === "prepared-failed"
            ? composerSession.directoryLabel
            : "Approved workspace");
    const hasOptimisticPrompt = optimisticPrompt.kind === "pending";
    const ownerConversation = ready.conversation.origin.kind === "owner";
    const hasDraftContent =
        draft.trim().length > 0 || (ownerConversation && (draftImages.length > 0 || draftResources.length > 0));
    const canAttach =
        ownerConversation &&
        preparedComposer !== undefined &&
        !configuring &&
        (preparedComposer.ready.capabilities.imagePrompt || preparedComposer.ready.capabilities.embeddedContextPrompt);
    const workspaceLocked =
        preparedComposer === undefined ||
        ready.messages.length > 0 ||
        hasOptimisticPrompt ||
        turnRunning ||
        configuring;
    const canSubmit =
        hasDraftContent &&
        (!ownerConversation || preparedComposer !== undefined) &&
        !submitting &&
        !configuring &&
        !turnRunning &&
        bot.state.kind === "active";

    return (
        <div className="flex min-h-full flex-col">
            <div className="mx-auto w-full max-w-[840px] px-5 pt-5 sm:px-8">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b-[0.5px] border-black/8 pb-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <Link
                            aria-label="Back to conversations"
                            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground no-underline hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                            to={botConversationsRoutePath(connection.channelId, bot.botId)}
                        >
                            <ArrowLeft aria-hidden="true" className="size-4" />
                        </Link>
                        <span className="min-w-0">
                            <h2 className="truncate text-base font-semibold tracking-[-0.015em]">
                                {botConversationTitle(ready.conversation)}
                            </h2>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                Behavior revision {ready.conversation.behaviorRevisionId.slice(-6)} · Binding v
                                {ready.conversation.bindingRevision}
                            </span>
                        </span>
                    </div>
                    <Button
                        aria-label="Refresh conversation"
                        className="size-11 sm:size-9"
                        onClick={() => void thread.load(signal)}
                        size="icon"
                        variant="ghost"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[840px] flex-1 px-5 py-6 sm:px-8">
                {ready.nextCursor.length > 0 && (
                    <div className="mb-6 flex justify-center">
                        <Button
                            aria-busy={loadingEarlier}
                            className="min-h-11"
                            disabled={loadingEarlier}
                            onClick={() => void thread.loadEarlier(signal)}
                            variant="outline"
                        >
                            {loadingEarlier && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
                            Load earlier messages
                        </Button>
                    </div>
                )}
                {ready.messages.length === 0 && !hasOptimisticPrompt ? (
                    <section className="mx-auto mt-8 max-w-lg text-center">
                        <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#eefaf3] text-[#218854]">
                            <Bot aria-hidden="true" className="size-5" />
                        </span>
                        <h3 className="mt-4 text-lg font-semibold">Message {bot.displayName}</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            This conversation is pinned to its approved local behavior and execution target.
                        </p>
                    </section>
                ) : (
                    <ol aria-label="Conversation messages" className="contents">
                        {ready.messages.map((message) => (
                            <ConversationMessage botName={bot.displayName} key={message.commandId} message={message} />
                        ))}
                        {optimisticPrompt.kind === "pending" &&
                            !ready.messages.some(
                                (message) => message.commandId === optimisticPrompt.clientMessageId,
                            ) && (
                                <li className="contents">
                                    <UserPromptMessage
                                        images={optimisticPrompt.images}
                                        resources={optimisticPrompt.resources}
                                        text={optimisticPrompt.text}
                                    />
                                    <div
                                        aria-label={`${bot.displayName} is working`}
                                        className="thinking-indicator mb-9 inline-flex h-6 items-center gap-1"
                                        role="status"
                                    >
                                        <span />
                                        <span />
                                        <span />
                                    </div>
                                </li>
                            )}
                    </ol>
                )}
            </div>

            <div className="sticky bottom-0 z-[8] mt-auto bg-gradient-to-t from-background via-background to-transparent px-2 pt-2 pb-3 md:px-3 md:pt-3">
                {operationError.length > 0 && (
                    <div
                        className="mx-auto mb-2 w-full max-w-[840px] rounded-[9px] border-[0.5px] border-destructive/20 bg-destructive/5 px-[11px] py-[9px] text-xs leading-[18px] text-destructive"
                        role="alert"
                    >
                        {operationError}
                    </div>
                )}
                <form
                    aria-busy={submitting || configuring || composerSession.kind === "preparing"}
                    className="composer-shell relative mx-auto w-full max-w-[840px] rounded-2xl bg-white px-2 py-1.5 sm:px-2.5 sm:py-2 md:rounded-[18px] md:px-3 md:py-2.5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void composer.submit(signal);
                    }}
                >
                    {(draftImages.length > 0 || draftResources.length > 0) && (
                        <fieldset className="mb-2 flex flex-wrap items-center gap-1.5" data-selected-context="">
                            <legend className="sr-only">Selected files</legend>
                            {draftImages.length > 0 && (
                                <ul aria-label="Prompt images" className="contents">
                                    {draftImages.map((image, index) => (
                                        <li
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                            key={`${index.toString()}:${image.name}`}
                                        >
                                            <ImageIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                            <span className="max-w-40 truncate">{image.name}</span>
                                            <Button
                                                aria-label={`Remove ${image.name}`}
                                                className="size-11 lg:size-8"
                                                onClick={() => composer.removeImage(image.name)}
                                                size="icon"
                                                type="button"
                                                variant="ghost"
                                            >
                                                <X aria-hidden="true" className="size-3" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {draftResources.length > 0 && (
                                <ul aria-label="Prompt resources" className="contents">
                                    {draftResources.map((resource, index) => (
                                        <li
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                            key={`${index.toString()}:${resource.uri}`}
                                        >
                                            <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                            <span className="max-w-40 truncate">{resource.name}</span>
                                            <Button
                                                aria-label={`Remove ${resource.name}`}
                                                className="size-11 lg:size-8"
                                                onClick={() => composer.removeResource(resource.name)}
                                                size="icon"
                                                type="button"
                                                variant="ghost"
                                            >
                                                <X aria-hidden="true" className="size-3" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </fieldset>
                    )}
                    <label className="sr-only" htmlFor="bot-message-composer">
                        Message {bot.displayName}
                    </label>
                    <textarea
                        aria-describedby="bot-composer-hint"
                        className="max-h-44 min-h-12 w-full resize-none bg-transparent px-1 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground sm:text-sm md:min-h-16"
                        disabled={submitting || turnRunning || bot.state.kind !== "active"}
                        id="bot-message-composer"
                        maxLength={100000}
                        onChange={(event) => composer.setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void composer.submit(signal);
                            }
                        }}
                        placeholder={
                            turnRunning
                                ? `${bot.displayName} is working…`
                                : ownerConversation && preparedComposer === undefined
                                  ? composerSession.statusLabel
                                  : `Message ${bot.displayName}`
                        }
                        ref={textareaRef}
                        rows={1}
                        value={draft}
                    />
                    <div className="mt-1 flex min-h-11 items-center justify-between gap-1 lg:mt-2.5 lg:min-h-9 lg:gap-2">
                        <fieldset className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1">
                            <legend className="sr-only">Prompt and run controls</legend>
                            {ownerConversation && (
                                <>
                                    <Button
                                        aria-label="Attach images or text resources"
                                        className="size-11 rounded-full text-copy-secondary hover:bg-black/[0.04] lg:size-9"
                                        disabled={!canAttach || turnRunning || attaching}
                                        onClick={() => fileInputRef.current?.click()}
                                        size="icon"
                                        title={
                                            canAttach
                                                ? "Attach images or text resources"
                                                : "This agent does not support attachments"
                                        }
                                        type="button"
                                        variant="ghost"
                                    >
                                        {attaching ? (
                                            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                                        ) : (
                                            <Paperclip className="size-4" />
                                        )}
                                    </Button>
                                    <input
                                        accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                                        aria-label="Choose files for Bot prompt"
                                        className="sr-only"
                                        multiple
                                        onChange={(event) => {
                                            if (event.currentTarget.files !== null) {
                                                void composer.attachFiles(event.currentTarget.files).finally(() => {
                                                    if (fileInputRef.current !== null) {
                                                        fileInputRef.current.value = "";
                                                    }
                                                });
                                            }
                                        }}
                                        ref={fileInputRef}
                                        type="file"
                                    />
                                </>
                            )}
                            {ownerConversation ? (
                                <>
                                    <WorkspacePickerControl
                                        additionalDirectories={[]}
                                        canAddAdditionalDirectories={false}
                                        directoryId={composerDirectoryId}
                                        directoryLabel={composerDirectoryLabel}
                                        listDirectories={(directoryId, listSignal) =>
                                            listWorkspace(directoryId, AbortSignal.any([signal, listSignal]))
                                        }
                                        locked={workspaceLocked}
                                        onFailure={thread.reportError}
                                        onSelectPrimary={(directory) =>
                                            sessionViewModel.selectWorkspace(directory, workspaceLocked, signal)
                                        }
                                        onToggleAdditional={() => undefined}
                                    />
                                    <SessionConfigControlsView
                                        agentLabel={preparedComposer?.ready.agentName ?? bot.displayName}
                                        directoryLabel={composerDirectoryLabel}
                                        failure={preparedFailure}
                                        isPreparing={
                                            composerSession.kind === "loading" || composerSession.kind === "preparing"
                                        }
                                        isReady={preparedComposer !== undefined}
                                        isRunning={turnRunning}
                                        onConfigure={(option, value, booleanValue) =>
                                            sessionViewModel.configure(option, value, booleanValue, signal)
                                        }
                                        onRetry={() => void sessionViewModel.prepare(readySessionId, signal)}
                                        options={preparedComposer?.ready.configOptions ?? []}
                                        statusLabel={composerSession.statusLabel}
                                    />
                                </>
                            ) : (
                                <span className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-muted-foreground lg:min-h-9">
                                    <LockKeyhole aria-hidden="true" className="size-3.5" /> Pinned Bot settings
                                </span>
                            )}
                        </fieldset>
                        {cancellableTurn !== undefined ? (
                            <Button
                                aria-busy={cancelling}
                                aria-label="Stop response"
                                className="size-11 rounded-full lg:size-9"
                                disabled={cancelling}
                                onClick={() => void thread.cancel(signal)}
                                size="icon"
                                type="button"
                                variant="outline"
                            >
                                {cancelling ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <Square aria-hidden="true" className="size-3.5 fill-current" />
                                )}
                            </Button>
                        ) : (
                            <Button
                                aria-label="Send message"
                                className="size-11 rounded-full lg:size-9"
                                disabled={!canSubmit}
                                size="icon"
                                type="submit"
                            >
                                {submitting ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <Send aria-hidden="true" className="size-4" />
                                )}
                            </Button>
                        )}
                    </div>
                </form>
                <span className="sr-only" id="bot-composer-hint">
                    Enter to send. Shift and Enter inserts a new line.
                </span>
                <p aria-live="polite" className="sr-only">
                    {announcement}
                </p>
            </div>
        </div>
    );
}
