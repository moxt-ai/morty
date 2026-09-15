import {
    type AgentDisplayContent,
    MobiusAgentActivityEvent,
    MobiusAgentMessageEvent,
    type MobiusSessionEvent,
} from "@moxt-ai/mobius-sdk";
import { type MobiusBrowserClient, type MobiusBrowserHistory, MobiusPageRequest } from "@moxt-ai/mobius-sdk/browser";
import { MessageSquare, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import { AgentRichContent } from "../../components/agents/agent-rich-content.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { dataTestId } from "../../data-testid.ts";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import { AttemptFailure } from "./attempt-failure.tsx";
import { ChatControls } from "./chat-controls.tsx";
import { DraftChatControls } from "./draft-chat-controls.tsx";
import { LocalSessionPane } from "./local-session-pane.tsx";
import { LocalSessionSidebar, type OpenLocalSession } from "./local-session-sidebar.tsx";
import { PairingInstruction } from "./pairing-instruction.tsx";

type SetupReason = "unconfigured" | "inactive" | "no-selection" | "agent-missing" | "agent-offline" | "agent-required";

interface ActivityContent {
    readonly commandId: string;
    readonly contents: readonly AgentDisplayContent[];
}

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

type State =
    | { readonly kind: "loading" }
    | { readonly kind: "draft"; readonly bot: ManagedBot }
    | { readonly kind: "setup"; readonly reason: SetupReason }
    | {
          readonly kind: "ready";
          readonly bot: ManagedBot;
          readonly client: MobiusBrowserClient;
          readonly history: MobiusBrowserHistory;
          readonly activityContents: ReadonlyMap<string, ActivityContent>;
      }
    | { readonly kind: "failed"; readonly message: string };
type Sending =
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | { readonly kind: "failed"; readonly message: string };

function BotArtifactContent({
    botId,
    contents,
    requests,
    sessionId,
}: {
    readonly botId: string;
    readonly contents: readonly AgentDisplayContent[];
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly sessionId: string;
}) {
    const [client, setClient] = useState<Awaited<ReturnType<BotChatApi["connectSession"]>> | null | undefined>();
    useEffect(() => {
        const controller = new AbortController();
        let connected: Awaited<ReturnType<BotChatApi["connectSession"]>> | null = null;
        void requests
            .connectSession(botId, sessionId, controller.signal)
            .then((value) => {
                if (controller.signal.aborted) {
                    value.close();
                    return;
                }
                connected = value;
                setClient(value);
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setClient(null);
                }
            });
        return () => {
            controller.abort();
            connected?.close();
        };
    }, [botId, requests, sessionId]);
    return client === undefined ? (
        <p className="text-xs text-muted-foreground">Loading image…</p>
    ) : client === null ? (
        <p className="text-xs text-muted-foreground">Image content could not be loaded.</p>
    ) : (
        <AgentRichContent contents={contents} serviceClient={client} sessionId={sessionId} />
    );
}

function BotTurnArtifacts({
    commandId,
    activityContents,
    botId,
    requests,
    sessionId,
}: {
    readonly commandId: string;
    readonly activityContents: ReadonlyMap<string, ActivityContent>;
    readonly botId: string;
    readonly requests: Pick<BotChatApi, "connectSession">;
    readonly sessionId: string;
}) {
    const contents = [...activityContents.values()].flatMap((activity) =>
        activity.commandId === commandId ? activity.contents.filter((content) => content.type === "image") : [],
    );
    return contents.length === 0 ? null : (
        <section aria-label="Agent image output" className="min-w-0 px-4">
            <BotArtifactContent botId={botId} contents={contents} requests={requests} sessionId={sessionId} />
        </section>
    );
}

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

function updateActivityContents(
    current: State,
    client: MobiusBrowserClient,
    event: { readonly payload: unknown },
): State {
    if (current.kind !== "ready" || current.client !== client || !(event.payload instanceof MobiusAgentActivityEvent)) {
        return current;
    }
    const contents = new Map(current.activityContents);
    contents.set(event.payload.activityId, { commandId: event.payload.commandId, contents: event.payload.content });
    return { ...current, activityContents: contents };
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

function attemptStatus(kind: string): string {
    switch (kind) {
        case "none":
        case "dispatching":
            return "Waiting for your agent…";
        case "running":
            return "Agent is thinking…";
        case "waiting_input":
            return "Your agent needs input. Check your local agent.";
        case "succeeded":
            return "Agent finished without a text response.";
        case "cancelled":
            return "Response cancelled.";
        case "failed":
            return "The agent could not complete this message.";
        case "indeterminate":
            return "The agent's completion status is unknown. Check your local agent.";
        default:
            return "Agent status is unavailable.";
    }
}

export function BotChatHome({
    requests,
}: {
    readonly requests: Pick<
        BotChatApi,
        | "listBots"
        | "connectConversation"
        | "workspace"
        | "selectAgent"
        | "nativeSessions"
        | "connectSession"
        | "createPairingInstruction"
        | "createConversation"
        | "draftSettings"
    >;
}) {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [revision, retry] = useState(0);
    const [draft, setDraft] = useState("");
    const [initialTarget] = useState<
        | { readonly kind: "draft"; readonly key: string }
        | { readonly kind: "existing"; readonly conversationId: string }
    >(() => {
        const conversationId = new URL(window.location.href).searchParams.get("conversationId");
        return conversationId !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(conversationId)
            ? { kind: "existing", conversationId }
            : { kind: "draft", key: crypto.randomUUID() };
    });
    const target = useRef(initialTarget);
    const [draftSettings, setDraftSettings] = useState<ChatDraftConfiguration | null>(null);
    const messageAttempt = useRef<{ readonly content: string; readonly key: string } | null>(null);
    const [sending, setSending] = useState<Sending>({ kind: "idle" });
    const lifetime = useRef<{
        readonly controller: AbortController;
        readonly adopt: (bot: ManagedBot, client: MobiusBrowserClient, history: MobiusBrowserHistory) => void;
    } | null>(null);
    const messageList = useRef<HTMLDivElement | null>(null);
    const followLatest = useRef(true);
    const [conversation, setConversation] = useState<
        { readonly kind: "bot" } | { readonly kind: "local"; readonly session: OpenLocalSession }
    >({ kind: "bot" });
    const showBot = useCallback(() => setConversation({ kind: "bot" }), []);
    const newConversation = useCallback(() => {
        lifetime.current?.controller.abort();
        setDraft("");
        setSending({ kind: "idle" });
        setDraftSettings(null);
        messageAttempt.current = null;
        setConversation({ kind: "bot" });
        followLatest.current = true;
        const key = crypto.randomUUID();
        const url = new URL(window.location.href);
        url.searchParams.delete("conversation");
        url.searchParams.delete("conversationId");
        window.history.replaceState(window.history.state, "", url);
        target.current = { kind: "draft", key };
        retry((value) => value + 1);
    }, []);
    useEffect(() => {
        if (state.kind === "ready" && followLatest.current && messageList.current !== null) {
            messageList.current.scrollTop = messageList.current.scrollHeight;
        }
    }, [state]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect explicitly restarts the SDK session.
    useEffect(() => {
        const controller = new AbortController();
        setConversation({ kind: "bot" });
        let client: MobiusBrowserClient | null = null;
        let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
        setState((current) => (current.kind === "setup" ? current : { kind: "loading" }));
        const open = async () => {
            const bot = (await requests.listBots(controller.signal))[0];
            if (bot === undefined) {
                throw new Error("Your Bot is unavailable.");
            }
            const workspace = await requests.workspace(bot.botId, controller.signal);
            controller.signal.throwIfAborted();
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
            const session = await requests.connectConversation(
                bot.botId,
                controller.signal,
                target.current.conversationId,
            );
            client = session;
            const history = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
            await observe(bot, session, history);
        };
        const observe = async (bot: ManagedBot, session: MobiusBrowserClient, history: MobiusBrowserHistory) => {
            client = session;
            let snapshotSequence = BigInt(history.lastCommittedSeq);
            controller.signal.throwIfAborted();
            setState({ activityContents: new Map(), kind: "ready", bot, client: session, history });
            const refresh = async () => {
                const updated = await session.history.read(new MobiusPageRequest(100, ""), controller.signal);
                if (!controller.signal.aborted) {
                    snapshotSequence = BigInt(updated.lastCommittedSeq);
                    setState((current) => updateHistory(current, session, updated));
                }
            };
            const receive = async (event: MobiusSessionEvent) => {
                setState((current) => updateActivityContents(current, session, event));
                if (event.payload instanceof MobiusAgentMessageEvent) {
                    setState((current) => updateStreamedHistory(current, session, event));
                } else if (
                    !(event.payload instanceof MobiusAgentActivityEvent) &&
                    BigInt(event.sequence) > snapshotSequence
                ) {
                    await refresh();
                }
                return true;
            };
            let events = await session.readEvents(new MobiusPageRequest(10, ""), controller.signal);
            for (const event of events.events) {
                await receive(event);
            }
            while (events.hasMore) {
                events = await session.readEvents(new MobiusPageRequest(10, events.cursor), controller.signal);
                for (const event of events.events) {
                    await receive(event);
                }
            }
            const subscription = await session.events.subscribe(events.cursor, { receive }, controller.signal);
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
            draft.trim().length === 0
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
                );
                controller.signal.throwIfAborted();
                createdId = access.conversationId;
                createdClient = await requests.connectConversation(state.bot.botId, controller.signal, createdId);
                client = createdClient;
                const snapshot = await client.session.read(controller.signal);
                const sessionClient = await requests.connectSession(
                    state.bot.botId,
                    snapshot.session.sessionId,
                    controller.signal,
                );
                try {
                    await sessionClient.sessions.prepare(snapshot.session.sessionId, controller.signal);
                    const configuration = draftSettings.configuration;
                    const updated = await sessionClient.sessions.updateConfiguration(
                        snapshot.session.sessionId,
                        {
                            configId: configuration.configId,
                            value: configuration.value,
                            valueType: configuration.valueType,
                            booleanValue: configuration.booleanValue,
                        },
                        controller.signal,
                    );
                    if (
                        !updated.configOptions.some(
                            (option) =>
                                option.id === configuration.configId && option.currentValue === configuration.value,
                        )
                    ) {
                        throw new Error(
                            "The harness did not confirm the selected model. Choose a model before retrying your message.",
                        );
                    }
                } finally {
                    sessionClient.close();
                }
            } else {
                client = state.client;
            }
            const message = await client.messages.create(
                {
                    content: attempt.content,
                    idempotencyKey: attempt.key,
                    artifactIds: [],
                    images: [],
                    resources: [],
                },
                controller.signal,
            );
            await client.messages.run(message.messageId, controller.signal);
            const history = await client.history.read(new MobiusPageRequest(100, ""), controller.signal);
            if (!controller.signal.aborted) {
                if (createdId !== null) {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("conversation");
                    url.searchParams.set("conversationId", createdId);
                    window.history.replaceState(window.history.state, "", url);
                    target.current = { kind: "existing", conversationId: createdId };
                    connection.adopt(state.bot, client, history);
                    createdClient = null;
                } else {
                    setState((current) => updateHistory(current, client, history));
                }
                setDraft("");
                messageAttempt.current = null;
                setSending({ kind: "idle" });
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setSending({
                    kind: "failed",
                    message: cause instanceof Error ? cause.message : "The message could not be sent.",
                });
            }
        } finally {
            createdClient?.close();
        }
    };

    return (
        <main
            aria-label="Chat"
            data-chat-state={state.kind === "ready" ? "connected" : "disconnected"}
            className="flex h-dvh min-h-0 flex-col bg-background text-foreground sm:flex-row"
        >
            {(state.kind === "ready" || state.kind === "draft") && (
                <LocalSessionSidebar
                    activeEntryId={conversation.kind === "local" ? conversation.session.entry.entryId : ""}
                    botId={state.bot.botId}
                    requests={requests}
                    onOpen={(session) => setConversation({ kind: "local", session })}
                    onChat={showBot}
                    onNewConversation={newConversation}
                />
            )}
            {conversation.kind === "local" && (state.kind === "ready" || state.kind === "draft") ? (
                <LocalSessionPane
                    botId={state.bot.botId}
                    requests={requests}
                    key={
                        conversation.session.result.action === "preview"
                            ? conversation.session.result.targetSessionId
                            : conversation.session.result.ready.sessionId
                    }
                    session={conversation.session}
                    onBack={showBot}
                />
            ) : (
                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div
                        ref={messageList}
                        onScroll={(event) => {
                            const element = event.currentTarget;
                            followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        }}
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
                        role="log"
                        aria-label="Messages"
                    >
                        {state.kind === "loading" ? (
                            <div className="m-auto">
                                <Spinner label="Connecting to your agent" />
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
                                    Checking automatically every 5 seconds. Chat will open when this Bot is active and
                                    its selected agent is online.
                                </p>
                            </section>
                        ) : state.kind === "failed" ? (
                            <div className="m-auto grid justify-items-center gap-4 text-center">
                                <p role="alert">{state.message}</p>
                                <Button onClick={() => retry((value) => value + 1)}>Reconnect</Button>
                                <PairingInstruction requests={requests} />
                            </div>
                        ) : state.kind === "draft" || state.history.turns.length === 0 ? (
                            <div className="m-auto text-center">
                                <h1 className="text-2xl font-semibold">{state.bot.displayName}</h1>
                                <p className="mt-2 text-sm text-muted-foreground">Send a message to your agent.</p>
                            </div>
                        ) : (
                            [...state.history.turns].reverse().map((turn) => (
                                <div
                                    key={turn.commandId}
                                    className="mx-auto grid min-w-0 w-full max-w-3xl gap-4 [overflow-wrap:anywhere]"
                                >
                                    <article
                                        className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent px-4 py-3"
                                        aria-label="Your message"
                                        data-testid={dataTestId.userMessage}
                                    >
                                        {turn.prompt}
                                    </article>
                                    {turn.response.length > 0 ? (
                                        <article
                                            className="min-w-0 px-4 py-3"
                                            aria-label="Agent response"
                                            data-testid={dataTestId.agentResponse}
                                        >
                                            <AgentMarkdown
                                                markdown={turn.response}
                                                streaming={turn.attempt.kind === "running"}
                                            />
                                        </article>
                                    ) : turn.attempt.kind !== "failed" ? (
                                        <p role="status" className="px-4 text-sm text-muted-foreground">
                                            {attemptStatus(turn.attempt.kind)}
                                        </p>
                                    ) : null}
                                    <BotTurnArtifacts
                                        commandId={turn.commandId}
                                        activityContents={state.activityContents}
                                        botId={state.bot.botId}
                                        requests={requests}
                                        sessionId={turn.sessionId}
                                    />
                                    <AttemptFailure attempt={turn.attempt} botId={state.bot.botId} />
                                </div>
                            ))
                        )}
                    </div>
                    {(state.kind === "ready" || state.kind === "draft") && (
                        <form
                            className="mx-auto mb-6 w-full max-w-3xl px-4"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void send();
                            }}
                        >
                            <div className="mb-3">
                                {state.kind === "draft" ? (
                                    <DraftChatControls
                                        key={target.current.kind === "draft" ? target.current.key : "existing"}
                                        botId={state.bot.botId}
                                        requests={requests}
                                        disabled={sending.kind === "sending"}
                                        onSettings={setDraftSettings}
                                    />
                                ) : (
                                    <ChatControls botId={state.bot.botId} client={state.client} requests={requests} />
                                )}
                            </div>
                            {sending.kind === "failed" && (
                                <p role="alert" className="mb-2 text-sm text-destructive">
                                    {sending.message}
                                </p>
                            )}
                            <div className="flex items-end gap-3 rounded-2xl border border-border bg-card p-4">
                                <Textarea
                                    aria-label="Message"
                                    data-testid={dataTestId.messageComposer}
                                    placeholder="Message your agent…"
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    disabled={sending.kind === "sending"}
                                />
                                <Button
                                    type="submit"
                                    size="icon"
                                    aria-label="Send message"
                                    data-testid={dataTestId.sendMessage}
                                    disabled={
                                        sending.kind === "sending" ||
                                        draft.trim().length === 0 ||
                                        (state.kind === "draft" && draftSettings === null)
                                    }
                                >
                                    <Send className="size-4" aria-hidden="true" />
                                </Button>
                            </div>
                        </form>
                    )}
                </section>
            )}
        </main>
    );
}
