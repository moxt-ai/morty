import type {
    NativeHistoryMessage,
    NativeSessionEntry,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-protocol";
import type { MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import { History, LoaderCircle, Plus, Send, StopCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentMarkdown } from "../../components/agents/agent-markdown.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";

type RuntimeState =
    | { readonly kind: "connecting" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "ready";
          readonly agentRef: string;
          readonly client: MobiusChannelClient;
          readonly online: boolean;
          readonly modelSettingId: string;
          readonly models: readonly { readonly value: string; readonly name: string }[];
      };
type TurnState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly sessionId: string;
          readonly prompt: string;
          readonly text: string;
      }
    | { readonly kind: "unknown"; readonly message: string; readonly prompt: string };
type PendingInteraction =
    | { readonly kind: "permission"; readonly request: SessionPermissionRequestedEvent }
    | { readonly kind: "elicitation"; readonly request: SessionElicitationRequestedEvent };

function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The local Codex Runtime is unavailable.";
}

function nativeRequest(botId: string, agentRef: string, sessionId: string) {
    return {
        kind: "native.session.request" as const,
        agentId: agentRef,
        bindingId: botId,
        directoryId: "default",
        additionalDirectoryIds: [],
        sessionId,
        requestId: crypto.randomUUID(),
    };
}

async function localHistory(
    client: MobiusChannelClient,
    botId: string,
    agentRef: string,
    sessionId: string,
    signal: AbortSignal,
): Promise<{ readonly entry: NativeSessionEntry | null; readonly messages: readonly NativeHistoryMessage[] }> {
    const result = await client.manageNativeSession(
        {
            ...nativeRequest(botId, agentRef, crypto.randomUUID()),
            action: "linked-history",
            targetSessionId: sessionId,
        },
        signal,
    );
    if (result.action === "unlinked-history") {
        return { entry: null, messages: [] };
    }
    if (result.action !== "linked-history") {
        throw new Error("Codex returned invalid history.");
    }
    if (result.history.status === "unavailable") {
        throw new Error(result.history.cause.message);
    }
    return { entry: null, messages: result.history.messages };
}

export function LocalCodexChat({
    bot,
    bots,
    onSelectBot,
    requests,
}: {
    readonly bot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly onSelectBot: (botId: string) => void;
    readonly requests: Pick<
        BotChatApi,
        "localRuntime" | "localSessions" | "createLocalSession" | "connectLocalRuntime" | "agentSettings"
    >;
}) {
    const [runtime, setRuntime] = useState<RuntimeState>({ kind: "connecting" });
    const [sessions, setSessions] = useState<readonly ManagedChatSession[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [messages, setMessages] = useState<readonly NativeHistoryMessage[]>([]);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [selectedModel, setSelectedModel] = useState("");
    const [turn, setTurn] = useState<TurnState>({ kind: "idle" });
    const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
    const [elicitationValues, setElicitationValues] = useState<Readonly<Record<string, string>>>({});
    const [nativeEntries, setNativeEntries] = useState<readonly NativeSessionEntry[] | null>(null);
    const lifetime = useRef<AbortController | null>(null);
    const selectedRef = useRef<string | null>(null);
    const connectionRef = useRef<{ readonly client: MobiusChannelClient; readonly agentRef: string } | null>(null);
    const onlineRef = useRef(false);
    const refreshHistory = useCallback(
        async (client: MobiusChannelClient, agentRef: string, sessionId: string, signal: AbortSignal) => {
            try {
                const history = await localHistory(client, bot.botId, agentRef, sessionId, signal);
                signal.throwIfAborted();
                if (selectedRef.current !== sessionId) {
                    return;
                }
                setMessages(history.messages);
                setHistoryError(null);
                const firstPrompt = history.messages.find((message) => message.role === "user")?.text.trim();
                if (firstPrompt) {
                    setTitles((current) => new Map(current).set(sessionId, firstPrompt.slice(0, 60)));
                }
            } catch (error) {
                if (!signal.aborted && selectedRef.current === sessionId) {
                    setHistoryError(failureMessage(error));
                }
            }
        },
        [bot.botId],
    );

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setRuntime({ kind: "connecting" });
        setMessages([]);
        setSelectedId(null);
        setTurn({ kind: "idle" });
        setInteraction(null);
        connectionRef.current = null;
        onlineRef.current = false;
        void (async () => {
            try {
                const [configuration, saved] = await Promise.all([
                    requests.localRuntime(bot.botId, controller.signal),
                    requests.localSessions(bot.botId, controller.signal),
                ]);
                const discovered = await requests.agentSettings(
                    bot.botId,
                    configuration.agentRef,
                    false,
                    controller.signal,
                );
                const model = discovered.options.find(
                    (option) => option.category === "model" && option.type === "select",
                );
                if (model === undefined || model.type !== "select" || model.values.length === 0) {
                    throw new Error("Codex did not offer a model for this Bot.");
                }
                controller.signal.throwIfAborted();
                const client = await requests.connectLocalRuntime(bot.botId, controller.signal, {
                    onActivity: () => {},
                    onPermission: (request) => {
                        if (request.sessionId === selectedRef.current) {
                            setInteraction({ kind: "permission", request });
                        }
                    },
                    onPermissionResolved: (resolved) => {
                        setInteraction((current) =>
                            current?.request.interactionId === resolved.interactionId ? null : current,
                        );
                    },
                    onElicitation: (request) => {
                        if (request.sessionId === selectedRef.current) {
                            setElicitationValues(
                                Object.fromEntries(
                                    request.fields.map((field) => [
                                        field.name,
                                        field.hasDefaultValue
                                            ? field.type === "boolean"
                                                ? String(field.defaultBooleanValue)
                                                : field.type === "number" || field.type === "integer"
                                                  ? String(field.defaultNumberValue)
                                                  : field.defaultStringValue
                                            : "",
                                    ]),
                                ),
                            );
                            setInteraction({ kind: "elicitation", request });
                        }
                    },
                    onElicitationResolved: (resolved) => {
                        setInteraction((current) =>
                            current?.request.interactionId === resolved.interactionId ? null : current,
                        );
                    },
                    onStatus: (online) => {
                        const reconnected = online && !onlineRef.current;
                        onlineRef.current = online;
                        setRuntime((current) => (current.kind === "ready" ? { ...current, online } : current));
                        const selected = selectedRef.current;
                        const connection = connectionRef.current;
                        if (reconnected && selected !== null && connection !== null) {
                            void refreshHistory(connection.client, connection.agentRef, selected, controller.signal);
                        }
                    },
                });
                controller.signal.throwIfAborted();
                connectionRef.current = { client, agentRef: configuration.agentRef };
                setRuntime({
                    kind: "ready",
                    agentRef: configuration.agentRef,
                    client,
                    online: true,
                    modelSettingId: model.id,
                    models: model.values,
                });
                setSelectedModel(model.currentValue);
                setSessions(saved);
                const urlSession = new URL(window.location.href).searchParams.get("sessionId");
                const initial = saved.find((session) => session.id === urlSession)?.id ?? saved[0]?.id ?? null;
                setSelectedId(initial);
                selectedRef.current = initial;
                if (initial !== null) {
                    await refreshHistory(client, configuration.agentRef, initial, controller.signal);
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    setRuntime({ kind: "failed", message: failureMessage(error) });
                }
            }
        })();
        return () => {
            controller.abort();
            connectionRef.current = null;
            onlineRef.current = false;
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [bot.botId, refreshHistory, requests]);

    const open = async (sessionId: string) => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return;
        }
        setSelectedId(sessionId);
        selectedRef.current = sessionId;
        setMessages([]);
        setHistoryError(null);
        setTurn({ kind: "idle" });
        setInteraction(null);
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", sessionId);
        window.history.replaceState(window.history.state, "", url);
        await refreshHistory(runtime.client, runtime.agentRef, sessionId, lifetime.current.signal);
    };
    const newChat = async (): Promise<string | null> => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return null;
        }
        const created = await requests.createLocalSession(bot.botId, lifetime.current.signal);
        setSessions(await requests.localSessions(bot.botId, lifetime.current.signal));
        await open(created.sessionId);
        return created.sessionId;
    };
    const send = async () => {
        if (
            runtime.kind !== "ready" ||
            !runtime.online ||
            lifetime.current === null ||
            draft.trim().length === 0 ||
            turn.kind === "running"
        ) {
            return;
        }
        const prompt = draft.trim();
        const sessionId = selectedId ?? (await newChat());
        if (sessionId === null) {
            return;
        }
        const commandId = crypto.randomUUID();
        setDraft("");
        setTurn({ kind: "running", commandId, sessionId, prompt, text: "" });
        try {
            await runtime.client.prompt({
                agentId: runtime.agentRef,
                bindingId: bot.botId,
                commandId,
                directoryId: "default",
                prompt,
                sessionConfigurations: [
                    {
                        booleanValue: false,
                        configId: runtime.modelSettingId,
                        value: selectedModel,
                        valueType: "select",
                    },
                ],
                sessionId,
                observer: {
                    onDelta: (text) =>
                        setTurn((current) =>
                            current.kind === "running" && current.commandId === commandId
                                ? { ...current, text: current.text + text }
                                : current,
                        ),
                },
            });
            if (lifetime.current !== null) {
                await refreshHistory(runtime.client, runtime.agentRef, sessionId, lifetime.current.signal);
            }
            setTurn((current) =>
                current.kind === "running" && current.commandId === commandId ? { kind: "idle" } : current,
            );
        } catch (error) {
            if (selectedRef.current === sessionId) {
                setTurn({
                    kind: "unknown",
                    prompt,
                    message: `Delivery could not be confirmed: ${failureMessage(error)}. Check local history before sending again.`,
                });
            }
        }
    };
    const browse = async () => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return;
        }
        try {
            const result = await runtime.client.manageNativeSession(
                { ...nativeRequest(bot.botId, runtime.agentRef, crypto.randomUUID()), action: "list", cursor: null },
                lifetime.current.signal,
            );
            if (result.action !== "list") {
                throw new Error("Codex returned an invalid session list.");
            }
            setNativeEntries(result.entries);
        } catch (error) {
            setHistoryError(failureMessage(error));
        }
    };
    const importSession = async (entry: NativeSessionEntry) => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return;
        }
        try {
            const created = await requests.createLocalSession(bot.botId, lifetime.current.signal);
            const result = await runtime.client.manageNativeSession(
                {
                    ...nativeRequest(bot.botId, runtime.agentRef, crypto.randomUUID()),
                    action: "import",
                    entryId: entry.entryId,
                    targetSessionId: created.sessionId,
                },
                lifetime.current.signal,
            );
            if (result.action !== "import") {
                throw new Error("Codex could not import this session.");
            }
            setSessions(await requests.localSessions(bot.botId, lifetime.current.signal));
            setNativeEntries(null);
            await open(created.sessionId);
        } catch (error) {
            setHistoryError(failureMessage(error));
        }
    };
    const readImage = useCallback(
        async (path: string, signal: AbortSignal) => {
            if (runtime.kind !== "ready" || selectedId === null) {
                throw new Error("The Session is unavailable.");
            }
            const file = await runtime.client.readFile(selectedId, path, signal);
            return { bytes: file.bytes, mediaType: file.mediaType };
        },
        [runtime, selectedId],
    );
    const answerPermission = async (request: SessionPermissionRequestedEvent, optionId: string) => {
        if (runtime.kind !== "ready") {
            return;
        }
        try {
            await runtime.client.respondPermission({
                interactionId: request.interactionId,
                optionId,
                outcome: "selected",
                sessionId: request.sessionId,
            });
            setInteraction(null);
        } catch (error) {
            setHistoryError(failureMessage(error));
        }
    };
    const answerElicitation = async (
        request: SessionElicitationRequestedEvent,
        action: "accept" | "cancel" | "decline",
    ) => {
        if (runtime.kind !== "ready") {
            return;
        }
        try {
            const answers: Record<string, string | boolean | number | string[]> = {};
            if (action === "accept" && request.mode === "form") {
                for (const field of request.fields) {
                    const value = elicitationValues[field.name] ?? "";
                    if (value.length === 0 && !field.required) {
                        continue;
                    }
                    if (field.type === "boolean") {
                        answers[field.name] = value === "true";
                    } else if (field.type === "number" || field.type === "integer") {
                        answers[field.name] = Number(value);
                    } else if (field.type === "multiselect") {
                        answers[field.name] = value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean);
                    } else {
                        answers[field.name] = value;
                    }
                }
            }
            const content = action === "accept" && request.mode === "form" ? JSON.stringify(answers) : "";
            await runtime.client.respondElicitation({
                action,
                content,
                interactionId: request.interactionId,
                sessionId: request.sessionId,
            });
            setInteraction(null);
        } catch (error) {
            setHistoryError(failureMessage(error));
        }
    };

    return (
        <main aria-label="Chat" className="fixed inset-0 flex min-h-0 bg-background text-foreground">
            <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card p-3 max-sm:w-44">
                <label className="text-xs text-muted-foreground" htmlFor="local-bot-choice">
                    Bot
                </label>
                <select
                    className="mt-1 rounded-lg border border-border bg-background p-2 text-sm"
                    id="local-bot-choice"
                    onChange={(event) => onSelectBot(event.target.value)}
                    value={bot.botId}
                >
                    {bots.map((item) => (
                        <option key={item.botId} value={item.botId}>
                            {item.displayName}
                        </option>
                    ))}
                </select>
                <Button className="mt-4 justify-start gap-2" onClick={() => void newChat()} variant="outline">
                    <Plus className="size-4" /> New conversation
                </Button>
                <Button className="mt-2 justify-start gap-2" onClick={() => void browse()} variant="outline">
                    <History className="size-4" /> Local Codex sessions
                </Button>
                <nav aria-label="Conversations" className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                    {sessions.map((session) => (
                        <button
                            aria-current={selectedId === session.id ? "page" : undefined}
                            className="min-h-10 rounded-lg px-2 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted"
                            key={session.id}
                            onClick={() => void open(session.id)}
                            type="button"
                        >
                            {titles.get(session.id) ?? session.title}
                        </button>
                    ))}
                </nav>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 text-sm font-medium">
                    <span>{bot.displayName} · Codex</span>
                    {runtime.kind === "ready" && (
                        <select
                            aria-label="Model"
                            className="rounded-lg border border-border bg-background p-2 text-sm"
                            onChange={(event) => setSelectedModel(event.target.value)}
                            value={selectedModel}
                        >
                            {runtime.models.map((model) => (
                                <option key={model.value} value={model.value}>
                                    {model.name}
                                </option>
                            ))}
                        </select>
                    )}
                </header>
                {runtime.kind === "connecting" && (
                    <p className="m-auto flex items-center gap-2" role="status">
                        <LoaderCircle className="size-4 animate-spin" /> Connecting to Codex…
                    </p>
                )}
                {runtime.kind === "failed" && (
                    <p className="m-auto" role="alert">
                        {runtime.message}
                    </p>
                )}
                {runtime.kind === "ready" && (
                    <>
                        <div aria-label="Messages" className="flex-1 space-y-5 overflow-y-auto px-6 py-5" role="log">
                            {messages.map((message, index) => (
                                <article
                                    aria-label={message.role === "user" ? "Message from you" : "Agent response"}
                                    className="mx-auto max-w-3xl"
                                    key={`${index.toString()}:${message.role}`}
                                >
                                    <p className="mb-1 text-xs font-semibold text-muted-foreground">
                                        {message.role === "user" ? "You" : "Codex"}
                                    </p>
                                    <AgentMarkdown markdown={message.text} readImage={readImage} streaming={false} />
                                    {message.images?.map((image) => (
                                        <img
                                            alt={image.name}
                                            className="mt-2 max-h-96 max-w-full rounded-lg"
                                            key={`${image.name}:${image.mimeType}:${image.data.slice(0, 32)}`}
                                            src={`data:${image.mimeType};base64,${image.data}`}
                                        />
                                    ))}
                                </article>
                            ))}
                            {turn.kind === "running" && (
                                <>
                                    <article aria-label="Message from you" className="mx-auto max-w-3xl">
                                        <p className="mb-1 text-xs font-semibold text-muted-foreground">You</p>
                                        <AgentMarkdown markdown={turn.prompt} readImage={readImage} streaming={false} />
                                    </article>
                                    <article aria-label="Current Codex response" className="mx-auto max-w-3xl">
                                        <p className="text-xs font-semibold text-muted-foreground">Codex is working</p>
                                        <AgentMarkdown markdown={turn.text} readImage={readImage} streaming />
                                    </article>
                                </>
                            )}
                            {turn.kind === "unknown" && (
                                <div role="alert">
                                    <p>{turn.message}</p>
                                    <p className="mt-2 whitespace-pre-wrap">{turn.prompt}</p>
                                </div>
                            )}
                            {historyError !== null && <p role="alert">{historyError}</p>}
                            {interaction?.kind === "permission" && (
                                <fieldset
                                    aria-label="Codex permission request"
                                    className="mx-auto max-w-3xl rounded-xl border border-border bg-card p-4"
                                >
                                    <p className="font-medium">{interaction.request.title}</p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {interaction.request.options.map((option) => (
                                            <Button
                                                key={option.optionId}
                                                onClick={() =>
                                                    void answerPermission(interaction.request, option.optionId)
                                                }
                                                type="button"
                                                variant="outline"
                                            >
                                                {option.name}
                                            </Button>
                                        ))}
                                    </div>
                                </fieldset>
                            )}
                            {interaction?.kind === "elicitation" && (
                                <fieldset
                                    aria-label="Codex input request"
                                    className="mx-auto max-w-3xl space-y-3 rounded-xl border border-border bg-card p-4"
                                >
                                    <p className="font-medium">{interaction.request.message}</p>
                                    {interaction.request.mode === "url" && (
                                        <a
                                            className="underline"
                                            href={interaction.request.url}
                                            rel="noreferrer"
                                            target="_blank"
                                        >
                                            Open authorization page
                                        </a>
                                    )}
                                    {interaction.request.mode === "form" &&
                                        interaction.request.fields.map((field) => (
                                            <div className="block text-sm" key={field.name}>
                                                <label className="mb-1 block" htmlFor={`elicitation-${field.name}`}>
                                                    {field.title}
                                                </label>
                                                {field.type === "boolean" ? (
                                                    <input
                                                        checked={elicitationValues[field.name] === "true"}
                                                        id={`elicitation-${field.name}`}
                                                        onChange={(event) =>
                                                            setElicitationValues((current) => ({
                                                                ...current,
                                                                [field.name]: String(event.target.checked),
                                                            }))
                                                        }
                                                        type="checkbox"
                                                    />
                                                ) : field.type === "select" ? (
                                                    <select
                                                        className="w-full rounded border border-border bg-background p-2"
                                                        id={`elicitation-${field.name}`}
                                                        onChange={(event) =>
                                                            setElicitationValues((current) => ({
                                                                ...current,
                                                                [field.name]: event.target.value,
                                                            }))
                                                        }
                                                        value={elicitationValues[field.name] ?? ""}
                                                    >
                                                        <option value="">Choose…</option>
                                                        {field.options.map((option) => (
                                                            <option key={option.value} value={option.value}>
                                                                {option.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input
                                                        className="w-full rounded border border-border bg-background p-2"
                                                        id={`elicitation-${field.name}`}
                                                        onChange={(event) =>
                                                            setElicitationValues((current) => ({
                                                                ...current,
                                                                [field.name]: event.target.value,
                                                            }))
                                                        }
                                                        type={
                                                            field.type === "number" || field.type === "integer"
                                                                ? "number"
                                                                : "text"
                                                        }
                                                        value={elicitationValues[field.name] ?? ""}
                                                    />
                                                )}
                                                {field.description && (
                                                    <span className="block text-xs text-muted-foreground">
                                                        {field.description}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    <div className="flex gap-2">
                                        <Button
                                            onClick={() => void answerElicitation(interaction.request, "accept")}
                                            type="button"
                                        >
                                            Continue
                                        </Button>
                                        <Button
                                            onClick={() => void answerElicitation(interaction.request, "decline")}
                                            type="button"
                                            variant="outline"
                                        >
                                            Decline
                                        </Button>
                                    </div>
                                </fieldset>
                            )}
                        </div>
                        <form
                            className="border-t border-border p-4"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void send();
                            }}
                        >
                            <div className="mx-auto flex max-w-3xl gap-2">
                                <textarea
                                    aria-label="Message"
                                    className="min-h-14 flex-1 resize-y rounded-xl border border-border bg-card p-3 text-sm"
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            void send();
                                        }
                                    }}
                                    placeholder="Ask Codex…"
                                    value={draft}
                                />
                                {turn.kind === "running" ? (
                                    <Button
                                        aria-label="Cancel turn"
                                        onClick={() => {
                                            runtime.client.cancel({
                                                commandId: turn.commandId,
                                                sessionId: turn.sessionId,
                                            });
                                            setTurn({
                                                kind: "unknown",
                                                prompt: turn.prompt,
                                                message:
                                                    "Cancellation requested. Check local history before sending again.",
                                            });
                                        }}
                                        type="button"
                                    >
                                        <StopCircle className="size-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        aria-label="Send message"
                                        disabled={!runtime.online || draft.trim().length === 0}
                                        type="submit"
                                    >
                                        <Send className="size-4" />
                                    </Button>
                                )}
                            </div>
                        </form>
                    </>
                )}
            </section>
            {nativeEntries !== null && (
                <div
                    aria-label="Local Codex sessions"
                    className="fixed inset-0 z-50 grid place-items-center bg-black/30"
                    role="dialog"
                >
                    <div className="max-h-[80vh] w-[min(600px,90vw)] overflow-y-auto rounded-xl bg-card p-5 shadow-xl">
                        <div className="mb-3 flex items-center justify-between">
                            <h2 className="font-semibold">Local Codex sessions</h2>
                            <Button onClick={() => setNativeEntries(null)} variant="outline">
                                Close
                            </Button>
                        </div>
                        {nativeEntries.length === 0 && <p>No local sessions were found.</p>}
                        {nativeEntries.map((entry) => (
                            <button
                                className="block w-full rounded-lg p-3 text-left hover:bg-muted"
                                key={entry.entryId}
                                onClick={() => void importSession(entry)}
                                type="button"
                            >
                                <span className="block text-sm font-medium">{entry.title}</span>
                                <span className="block text-xs text-muted-foreground">{entry.directoryLabel}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </main>
    );
}
