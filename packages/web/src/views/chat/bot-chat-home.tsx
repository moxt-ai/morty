import {
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    type MobiusSessionEvent,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    MobiusTurnStartedEvent,
} from "@moxt-ai/mobius-sdk";
import { type MobiusBrowserClient, type MobiusBrowserHistory, MobiusPageRequest } from "@moxt-ai/mobius-sdk/browser";
import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BotChatComposer, type ComposerAttachment } from "../../components/chat/bot-chat-composer.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { type RecordedAgentActivity, recordAgentActivity } from "../../services/chat/agent-activities.ts";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { ChatControls } from "./chat-controls.tsx";
import { ConversationSidebar } from "./conversation-sidebar.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { MobiusSessionPane } from "./mobius-session-pane.tsx";
import { MobiusSessionTurn } from "./mobius-session-turn.tsx";
import type { OpenMobiusSession } from "./native-session-dialog.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

type SetupReason = "unconfigured" | "inactive" | "no-selection" | "agent-missing" | "agent-offline" | "agent-required";

function setupReason(workspace: ChatWorkspace): SetupReason | null {
    if (workspace.status !== "active") {
        return workspace.status === "draft" ? "unconfigured" : "inactive";
    }
    const selected = workspace.selected;
    if (selected === null) {
        return "no-selection";
    }
    const agent = workspace.agents.find(
        (agent) => agent.runtimeId === selected.runtimeId && agent.agentRef === selected.agentRef,
    );
    if (agent === undefined) {
        return "agent-missing";
    }
    return agent.online ? null : "agent-offline";
}

function setupDescription(reason: SetupReason): string {
    switch (reason) {
        case "unconfigured":
            return "Your workspace is loaded. Paste this instruction into your local agent to connect it to this workspace.";
        case "inactive":
            return "Your workspace is loaded, but this Bot is not active, so Chat cannot reconnect. Use the instruction below to connect your local agent and activate Chat.";
        case "no-selection":
            return "Your workspace is loaded, but no agent is selected for this Bot. Use the instruction below to connect an agent to this workspace.";
        case "agent-missing":
            return "Your workspace is loaded, but the previously selected agent is no longer available in its agent list. Start the previously paired local agent, or use the instruction below to pair an agent again.";
        case "agent-offline":
            return "Your workspace is loaded, but your selected local agent is offline. Start the previously paired agent and check its internet connection. If you need to pair it again, use the instruction below.";
        case "agent-required":
            return "Your workspace is loaded, but the server could not connect Chat to an available agent. Check that your local agent is running, or use the instruction below to pair it again.";
    }
}

type ActiveState =
    | { readonly kind: "draft"; readonly bot: ManagedBot }
    | {
          readonly kind: "ready";
          readonly bot: ManagedBot;
          readonly client: MobiusBrowserClient;
          readonly history: MobiusBrowserHistory;
          readonly activities: ReadonlyMap<string, RecordedAgentActivity>;
      };
type State =
    | { readonly kind: "loading" }
    | { readonly kind: "switching"; readonly view: ActiveState }
    | ActiveState
    | { readonly kind: "setup"; readonly reason: SetupReason }
    | { readonly kind: "failed"; readonly message: string };
type Sending =
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | { readonly kind: "running"; readonly turnId: string }
    | { readonly kind: "stopping"; readonly turnId: string }
    | { readonly kind: "stop-failed"; readonly turnId: string; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

const ACTIVE_ATTEMPT_KINDS: ReadonlySet<string> = new Set(["dispatching", "running", "waiting_input"]);

function updateHistory(current: State, client: MobiusBrowserClient, history: MobiusBrowserHistory): State {
    if (
        current.kind !== "ready" ||
        current.client !== client ||
        BigInt(history.lastCommittedSeq) < BigInt(current.history.lastCommittedSeq)
    ) {
        return current;
    }
    return { ...current, history };
}

function updateActivities(current: State, client: MobiusBrowserClient, event: MobiusSessionEvent): State {
    if (current.kind !== "ready" || current.client !== client || !(event.payload instanceof MobiusAgentActivityEvent)) {
        return current;
    }
    const activities = recordAgentActivity(current.activities, event);
    return { ...current, activities };
}

function updateStreamedHistory(current: State, client: MobiusBrowserClient, event: MobiusSessionEvent): State {
    if (
        current.kind !== "ready" ||
        current.client !== client ||
        BigInt(event.sequence) <= BigInt(current.history.lastCommittedSeq)
    ) {
        return current;
    }
    const payload = event.payload;
    if (!(payload instanceof MobiusAgentMessageEvent)) {
        return current;
    }
    return {
        ...current,
        history: {
            ...current.history,
            lastCommittedSeq: event.sequence,
            turns: current.history.turns.map((turn) =>
                turn.commandId === payload.commandId && turn.sessionId === payload.sessionId
                    ? { ...turn, response: turn.response + payload.text }
                    : turn,
            ),
        },
    };
}

export function BotChatHome({
    requests,
    createTransfer,
}: {
    readonly requests: Pick<
        BotChatApi,
        | "listBots"
        | "access"
        | "connectConversation"
        | "workspace"
        | "selectAgent"
        | "nativeSessions"
        | "nativeSession"
        | "managedSessions"
        | "managedSession"
        | "continueNativeSession"
        | "connectSession"
        | "createPairingInstruction"
        | "createConversation"
        | "draftSettings"
    >;
    readonly createTransfer: (signal: AbortSignal) => Promise<IdentityTransfer>;
}) {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [revision, retry] = useState(0);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
    const [initialTarget] = useState<
        | { readonly kind: "draft"; readonly key: string }
        | { readonly kind: "conversation-access"; readonly conversationId: string }
        | { readonly kind: "session-access"; readonly sessionId: string }
        | { readonly kind: "continue"; readonly harness: string; readonly sessionId: string }
    >(() => {
        const url = new URL(window.location.href);
        const sessionId = url.searchParams.get("sessionId");
        const harness = url.searchParams.get("harness");
        if (sessionId !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(sessionId)) {
            if (harness !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(harness)) {
                return { kind: "continue", harness, sessionId };
            }
            return { kind: "session-access", sessionId };
        }
        const conversationId = url.searchParams.get("conversationId");
        return conversationId !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(conversationId)
            ? { kind: "conversation-access", conversationId }
            : { kind: "draft", key: crypto.randomUUID() };
    });
    const target = useRef(initialTarget);
    const [draftSettings, setDraftSettings] = useState<ChatDraftConfiguration | null>(null);
    const messageAttempt = useRef<{ readonly content: string; readonly key: string } | null>(null);
    const activeTurn = useRef<{
        readonly client: MobiusBrowserClient;
        readonly sessionId: string;
        readonly turnId: string;
    } | null>(null);
    const [sending, setSending] = useState<Sending>({ kind: "idle" });
    const lifetime = useRef<{
        readonly controller: AbortController;
        readonly adopt: (bot: ManagedBot, client: MobiusBrowserClient, history: MobiusBrowserHistory) => void;
    } | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const messageContent = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    const [sessionView, setSessionView] = useState<
        | { readonly kind: "conversation-access" }
        | { readonly kind: "session-access"; readonly session: OpenMobiusSession }
    >({ kind: "conversation-access" });
    const newConversation = useCallback(() => {
        lifetime.current?.controller.abort();
        setDraft("");
        setAttachments([]);
        setSending({ kind: "idle" });
        activeTurn.current = null;
        setDraftSettings(null);
        messageAttempt.current = null;
        setSessionView({ kind: "conversation-access" });
        followLatest.current = true;
        const key = crypto.randomUUID();
        const url = new URL(window.location.href);
        url.searchParams.delete("conversation");
        url.searchParams.delete("conversationId");
        url.searchParams.delete("sessionId");
        window.history.replaceState(window.history.state, "", url);
        target.current = { kind: "draft", key };
        retry((value) => value + 1);
    }, []);
    const openManaged = (kind: "conversation" | "fork" | "import", id: string) => {
        lifetime.current?.controller.abort();
        setDraft("");
        setAttachments([]);
        setSending({ kind: "idle" });
        activeTurn.current = null;
        setDraftSettings(null);
        messageAttempt.current = null;
        followLatest.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete("conversationId");
        url.searchParams.delete("sessionId");
        url.searchParams.set(kind === "conversation" ? "conversationId" : "sessionId", id);
        window.history.replaceState(window.history.state, "", url);
        target.current =
            kind === "conversation"
                ? { kind: "conversation-access", conversationId: id }
                : { kind: "session-access", sessionId: id };
        retry((value) => value + 1);
    };
    useLayoutEffect(() => {
        if (state.kind === "ready" && followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [state]);
    useLayoutEffect(() => {
        const list = messageList.current;
        const content = messageContent.current;
        if (sessionView.kind !== "conversation-access" || list === null || content === null) {
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
    }, [sessionView]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect explicitly restarts the SDK session.
    useEffect(() => {
        const controller = new AbortController();
        setSessionView({ kind: "conversation-access" });
        let client: MobiusBrowserClient | null = null;
        let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
        setState((current) => {
            if (current.kind === "setup") {
                return current;
            }
            const view = current.kind === "switching" ? current.view : current;
            if (view.kind === "ready" || view.kind === "draft") {
                // A new draft can render immediately while setup is revalidated. Keep the
                // current Bot available to the sidebar while another session opens, but
                // hide its stale conversation content behind the switching state.
                return target.current.kind === "draft" ? { kind: "draft", bot: view.bot } : { kind: "switching", view };
            }
            return { kind: "loading" };
        });
        const open = async () => {
            const bot = (await requests.listBots(controller.signal))[0];
            if (bot === undefined) {
                throw new Error("Your Bot is unavailable.");
            }
            const workspace = await requests.workspace(bot.botId, controller.signal);
            controller.signal.throwIfAborted();
            if (target.current.kind === "continue") {
                const session = await requests.continueNativeSession(
                    bot.botId,
                    target.current.harness,
                    target.current.sessionId,
                    controller.signal,
                );
                controller.signal.throwIfAborted();
                const url = new URL(window.location.href);
                url.searchParams.delete("harness");
                url.searchParams.set("sessionId", session.result.ready.sessionId);
                window.history.replaceState(window.history.state, "", url);
                target.current = { kind: "session-access", sessionId: session.result.ready.sessionId };
                setState({ kind: "draft", bot });
                setSessionView({ kind: "session-access", session });
                return;
            }
            if (target.current.kind === "session-access") {
                const session = await requests.managedSession(bot.botId, target.current.sessionId, controller.signal);
                controller.signal.throwIfAborted();
                setState({ kind: "draft", bot });
                setSessionView({ kind: "session-access", session });
                return;
            }
            const reason = target.current.kind === "draft" ? setupReason(workspace) : null;
            if (reason !== null) {
                setState({ kind: "setup", reason });
                reconciliationTimer = setTimeout(() => retry((value) => value + 1), 5000);
                return;
            }
            if (target.current.kind === "draft") {
                setState({ kind: "draft", bot });
                return;
            }
            const access = await requests.access(bot.botId, controller.signal, target.current.conversationId);
            controller.signal.throwIfAborted();
            const session = await requests.connectConversation(bot.botId, controller.signal, access);
            client = session;
            const history = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
            await observe(bot, session, history);
        };
        const observe = async (bot: ManagedBot, session: MobiusBrowserClient, history: MobiusBrowserHistory) => {
            client = session;
            let snapshotSequence = BigInt(history.lastCommittedSeq);
            controller.signal.throwIfAborted();
            setState({ activities: new Map(), kind: "ready", bot, client: session, history });
            const refresh = async () => {
                const updated = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
                if (!controller.signal.aborted) {
                    snapshotSequence = BigInt(updated.lastCommittedSeq);
                    setState((current) => updateHistory(current, session, updated));
                }
            };
            const receive = async (event: MobiusSessionEvent) => {
                setState((current) => updateActivities(current, session, event));
                if (event.payload instanceof MobiusAgentMessageEvent) {
                    setState((current) => updateStreamedHistory(current, session, event));
                } else if (
                    (event.payload instanceof MobiusTurnStartedEvent ||
                        event.payload instanceof MobiusTurnCompletedEvent ||
                        event.payload instanceof MobiusTurnFailedEvent) &&
                    BigInt(event.sequence) > snapshotSequence
                ) {
                    await refresh();
                    if (
                        (event.payload instanceof MobiusTurnCompletedEvent ||
                            event.payload instanceof MobiusTurnFailedEvent) &&
                        activeTurn.current?.client === session &&
                        activeTurn.current.sessionId === event.payload.sessionId
                    ) {
                        activeTurn.current = null;
                        setSending({ kind: "idle" });
                    }
                }
                return true;
            };
            const subscription = await session.events.subscribe("", { receive }, controller.signal);
            controller.signal.throwIfAborted();
            await subscription.completed;
            controller.signal.throwIfAborted();
            throw new Error("Chat updates disconnected. Reconnect to continue.");
        };
        const fail = (cause: unknown) => {
            client?.close();
            if (!controller.signal.aborted) {
                if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                    setState({ kind: "setup", reason: "agent-required" });
                    reconciliationTimer = setTimeout(() => retry((value) => value + 1), 5000);
                    return;
                }
                controller.abort();
                clearTimeout(reconciliationTimer);
                setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Chat is unavailable." });
            }
        };
        lifetime.current = {
            controller,
            adopt: (bot, session, history) => {
                void observe(bot, session, history).catch(fail);
            },
        };
        void open().catch(fail);
        return () => {
            clearTimeout(reconciliationTimer);
            controller.abort();
            client?.close();
            lifetime.current = null;
        };
    }, [requests, revision]);

    const send = async () => {
        const connection = lifetime.current;
        if (
            (state.kind !== "ready" && state.kind !== "draft") ||
            connection === null ||
            sending.kind === "sending" ||
            (draft.trim().length === 0 && attachments.length === 0)
        ) {
            return;
        }
        const controller = connection.controller;
        if (state.kind === "draft" && (target.current.kind !== "draft" || draftSettings === null)) {
            return;
        }
        setSending({ kind: "sending" });
        followLatest.current = true;
        let createdClient: MobiusBrowserClient | null = null;
        let createdId: string | null = null;
        try {
            const attempt =
                messageAttempt.current?.content === draft.trim()
                    ? messageAttempt.current
                    : { content: draft.trim(), key: crypto.randomUUID() };
            messageAttempt.current = attempt;
            let client: MobiusBrowserClient;
            if (state.kind === "draft") {
                if (target.current.kind !== "draft" || draftSettings === null) {
                    return;
                }
                const access = await requests.createConversation(
                    state.bot.botId,
                    target.current.key,
                    draftSettings,
                    controller.signal,
                    (
                        draft.trim() ||
                        attachments
                            .map((attachment) =>
                                attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                            )
                            .join(", ")
                    ).slice(0, 500),
                );
                controller.signal.throwIfAborted();
                createdId = access.conversationId;
                createdClient = await requests.connectConversation(state.bot.botId, controller.signal, access);
                client = createdClient;
            } else {
                client = state.client;
            }
            const message = await client.messages.create(
                {
                    content: attempt.content,
                    idempotencyKey: attempt.key,
                    artifactIds: [],
                    images: attachments.flatMap((attachment) =>
                        attachment.kind === "image" ? [attachment.image] : [],
                    ),
                    resources: attachments.flatMap((attachment) =>
                        attachment.kind === "resource" ? [attachment.resource] : [],
                    ),
                },
                controller.signal,
            );
            const turn = await client.messages.run(message.messageId, controller.signal);
            activeTurn.current = { client, sessionId: turn.sessionId, turnId: turn.turnId };
            setSending({ kind: "running", turnId: turn.turnId });
            const history = await client.history.read(new MobiusPageRequest(100, ""), controller.signal);
            if (!controller.signal.aborted) {
                if (createdId !== null) {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("conversation");
                    url.searchParams.set("conversationId", createdId);
                    window.history.replaceState(window.history.state, "", url);
                    target.current = { kind: "conversation-access", conversationId: createdId };
                    connection.adopt(state.bot, client, history);
                    createdClient = null;
                } else {
                    setState((current) => updateHistory(current, client, history));
                }
                setDraft("");
                setAttachments([]);
                messageAttempt.current = null;
                const recorded = history.turns.find((item) => item.messageId === message.messageId);
                if (recorded !== undefined && !ACTIVE_ATTEMPT_KINDS.has(recorded.attempt.kind)) {
                    activeTurn.current = null;
                    setSending({ kind: "idle" });
                }
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                const message = cause instanceof Error ? cause.message : "The message could not be sent.";
                const turn = activeTurn.current;
                setSending(
                    turn === null ? { kind: "failed", message } : { kind: "stop-failed", turnId: turn.turnId, message },
                );
            }
        } finally {
            createdClient?.close();
        }
    };

    const stop = async () => {
        const turn = activeTurn.current;
        const connection = lifetime.current;
        if (
            turn === null ||
            connection === null ||
            (sending.kind !== "running" && sending.kind !== "stop-failed") ||
            sending.turnId !== turn.turnId
        ) {
            return;
        }
        setSending({ kind: "stopping", turnId: turn.turnId });
        try {
            await turn.client.turns.cancel(
                turn.turnId,
                crypto.randomUUID(),
                AbortSignal.any([connection.controller.signal, AbortSignal.timeout(15000)]),
            );
            const history = await turn.client.history.read(
                new MobiusPageRequest(100, ""),
                AbortSignal.any([connection.controller.signal, AbortSignal.timeout(15000)]),
            );
            if (!connection.controller.signal.aborted && activeTurn.current === turn) {
                setState((current) => updateHistory(current, turn.client, history));
                activeTurn.current = null;
                setSending({ kind: "idle" });
            }
        } catch (cause) {
            if (!connection.controller.signal.aborted && activeTurn.current === turn) {
                setSending({
                    kind: "stop-failed",
                    turnId: turn.turnId,
                    message: cause instanceof Error ? cause.message : "The agent output could not be stopped.",
                });
            }
        }
    };

    const active =
        state.kind === "switching" ? state.view : state.kind === "ready" || state.kind === "draft" ? state : null;
    const switching = state.kind === "switching";

    return (
        <main
            aria-label="Chat"
            data-chat-state={state.kind === "ready" ? "connected" : "disconnected"}
            className="fixed inset-0 flex min-h-0 overflow-hidden bg-white text-foreground max-sm:flex-col sm:flex-row"
        >
            {active !== null && (
                <ConversationSidebar
                    activeId={
                        target.current.kind === "conversation-access"
                            ? target.current.conversationId
                            : target.current.kind === "session-access"
                              ? target.current.sessionId
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
            {sessionView.kind === "session-access" && active !== null ? (
                <MobiusSessionPane
                    botId={active.bot.botId}
                    requests={requests}
                    key={sessionView.session.result.ready.sessionId}
                    session={sessionView.session}
                />
            ) : (
                <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <div
                        ref={messageList}
                        onScroll={(event) => {
                            const element = event.currentTarget;
                            followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        }}
                        className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-4 py-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:px-8 sm:py-10"
                        role="log"
                        aria-label="Messages"
                    >
                        <div ref={messageContent} className="flex min-h-full flex-col gap-8">
                            {state.kind === "loading" || state.kind === "switching" ? (
                                <div className="m-auto">
                                    <Spinner
                                        label={
                                            state.kind === "switching"
                                                ? "Switching session"
                                                : "Connecting to your agent"
                                        }
                                    />
                                </div>
                            ) : state.kind === "setup" ? (
                                <section className="m-auto w-full max-w-lg animate-cloud-enter rounded-2xl border border-border bg-card p-8 shadow-sm motion-reduce:animate-none">
                                    <MessageSquare className="mb-5 size-8 text-primary" aria-hidden="true" />
                                    <h1 className="text-2xl font-semibold tracking-tight">
                                        {state.reason === "unconfigured"
                                            ? "Your Chat is ready to connect"
                                            : "Chat is waiting to reconnect"}
                                    </h1>
                                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                        {setupDescription(state.reason)}
                                    </p>
                                    <PairingInstruction requests={requests} />
                                    <p role="status" className="mt-4 text-sm text-muted-foreground">
                                        Checking automatically every 5 seconds. Chat will open when this Bot is active
                                        and its selected agent is online.
                                    </p>
                                </section>
                            ) : state.kind === "failed" ? (
                                <div className="m-auto grid justify-items-center gap-4 text-center">
                                    <p role="alert">{state.message}</p>
                                    <Button onClick={() => retry((value) => value + 1)}>Reconnect</Button>
                                    <PairingInstruction requests={requests} />
                                </div>
                            ) : active === null ? null : active.kind === "draft" ||
                              active.history.turns.length === 0 ? (
                                <div className="m-auto max-w-lg text-center">
                                    <span className="mx-auto mb-5 flex size-16 items-center justify-center rounded-[22px] bg-[#f2e8ff] text-[#a855f7] shadow-[inset_0_0_0_1px_rgba(168,85,247,0.08)]">
                                        <MessageSquare className="size-7" aria-hidden="true" />
                                    </span>
                                    <h1 className="text-3xl font-semibold tracking-tight">{active.bot.displayName}</h1>
                                </div>
                            ) : (
                                [...active.history.turns]
                                    .reverse()
                                    .map((turn) => (
                                        <MobiusSessionTurn
                                            key={`${turn.sessionId}:${turn.commandId}`}
                                            turn={turn}
                                            activities={active.activities}
                                            botId={active.bot.botId}
                                            requests={requests}
                                        />
                                    ))
                            )}
                        </div>
                    </div>
                    {active !== null && !switching && (
                        <BotChatComposer
                            attachments={attachments}
                            disabled={switching || sending.kind === "sending"}
                            draft={draft}
                            error={sending.kind === "failed" || sending.kind === "stop-failed" ? sending.message : ""}
                            onAttachmentsChange={setAttachments}
                            onDraftChange={setDraft}
                            onStop={() => void stop()}
                            onSubmit={() => void send()}
                            outputState={
                                sending.kind === "running" || sending.kind === "stop-failed"
                                    ? "running"
                                    : sending.kind === "stopping"
                                      ? "stopping"
                                      : "idle"
                            }
                            submitDisabled={
                                switching ||
                                (sending.kind !== "idle" && sending.kind !== "failed") ||
                                (draft.trim().length === 0 && attachments.length === 0) ||
                                (active.kind === "draft" && draftSettings === null)
                            }
                        >
                            {active.kind === "draft" ? (
                                <DraftChatControls
                                    key={target.current.kind === "draft" ? target.current.key : "existing"}
                                    botId={active.bot.botId}
                                    requests={requests}
                                    disabled={switching || sending.kind === "sending"}
                                    onSettings={setDraftSettings}
                                />
                            ) : (
                                <ChatControls
                                    botId={active.bot.botId}
                                    client={active.client}
                                    requests={requests}
                                    disabled={switching}
                                />
                            )}
                        </BotChatComposer>
                    )}
                </section>
            )}
        </main>
    );
}
