import type {
    NativeHistoryMessage,
    NativeSessionEntry,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-protocol";
import type { MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import { History, LoaderCircle, Plus, Send, StopCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/cloud-button.tsx";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { LocalAgentInteractions, type PendingInteraction } from "./local-agent-interactions.tsx";
import { LocalAgentSessionsDialog } from "./local-agent-sessions-dialog.tsx";
import { LocalAgentTranscript, type TurnState } from "./local-agent-transcript.tsx";

type RuntimeState =
    | { readonly kind: "connecting" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "ready";
          readonly agentRef: string;
          readonly client: MobiusChannelClient;
          readonly online: boolean;
          readonly modelSettingId: string | null;
          readonly models: readonly { readonly value: string; readonly name: string }[];
      };
function failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The local Agent Runtime is unavailable.";
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
    directoryId: string,
    additionalDirectoryIds: readonly string[],
    signal: AbortSignal,
): Promise<{ readonly entry: NativeSessionEntry | null; readonly messages: readonly NativeHistoryMessage[] }> {
    const result = await client.manageNativeSession(
        {
            ...nativeRequest(botId, agentRef, crypto.randomUUID()),
            directoryId,
            additionalDirectoryIds,
            action: "linked-history",
            targetSessionId: sessionId,
        },
        signal,
    );
    if (result.action !== "linked-history") {
        throw new Error("The Agent returned invalid history.");
    }
    if (result.history.status === "unavailable") {
        throw new Error(result.history.cause.message);
    }
    return { entry: null, messages: result.history.messages };
}

export function LocalAgentChat({
    bot,
    bots,
    onSelectBot,
    botActions,
    requests,
}: {
    readonly bot: ManagedBot;
    readonly bots: readonly ManagedBot[];
    readonly onSelectBot: (botId: string) => void;
    readonly botActions: ReactNode;
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
                const saved = (await requests.localSessions(bot.botId, signal)).find(
                    (session) => session.id === sessionId,
                );
                if (saved === undefined) {
                    throw new Error("The Chat session is no longer available.");
                }
                const history = await localHistory(
                    client,
                    bot.botId,
                    agentRef,
                    sessionId,
                    saved.directoryId,
                    saved.additionalDirectoryIds,
                    signal,
                );
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
        [bot.botId, requests],
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
                    modelSettingId: model?.id ?? null,
                    models: model?.type === "select" ? model.values : [],
                });
                setSelectedModel(model?.type === "select" ? model.currentValue : "");
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

    const open = async (session: ManagedChatSession) => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return;
        }
        const sessionId = session.id;
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
    const newChat = async (): Promise<ManagedChatSession | null> => {
        if (runtime.kind !== "ready" || lifetime.current === null) {
            return null;
        }
        try {
            const created = await requests.createLocalSession(bot.botId, { action: "create" }, lifetime.current.signal);
            const saved = await requests.localSessions(bot.botId, lifetime.current.signal);
            const session = saved.find((item) => item.id === created.sessionId);
            if (session === undefined) {
                throw new Error("The new Agent session was not saved by Chat.");
            }
            setSessions(saved);
            await open(session);
            return session;
        } catch (error) {
            setHistoryError(failureMessage(error));
            return null;
        }
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
        const session = selectedId === null ? await newChat() : sessions.find((item) => item.id === selectedId);
        if (session === null || session === undefined) {
            return;
        }
        const sessionId = session.id;
        const commandId = crypto.randomUUID();
        setDraft("");
        setTurn({ kind: "running", commandId, sessionId, prompt, text: "" });
        try {
            await runtime.client.prompt({
                agentId: runtime.agentRef,
                bindingId: bot.botId,
                commandId,
                directoryId: session.directoryId,
                additionalDirectoryIds: session.additionalDirectoryIds,
                prompt,
                sessionConfigurations:
                    runtime.modelSettingId === null
                        ? []
                        : [
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
                throw new Error("The Agent returned an invalid session list.");
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
            const created = await requests.createLocalSession(
                bot.botId,
                { action: "import", sessionId: entry.nativeSessionId },
                lifetime.current.signal,
            );
            const saved = await requests.localSessions(bot.botId, lifetime.current.signal);
            const session = saved.find((item) => item.id === created.sessionId);
            if (session === undefined) {
                throw new Error("The imported Agent session was not saved by Chat.");
            }
            setSessions(saved);
            setNativeEntries(null);
            await open(session);
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
                    <History className="size-4" /> Local Agent sessions
                </Button>
                <nav aria-label="Conversations" className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                    {sessions.map((session) => (
                        <button
                            aria-current={selectedId === session.id ? "page" : undefined}
                            className="min-h-10 rounded-lg px-2 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted"
                            key={session.id}
                            onClick={() => void open(session)}
                            type="button"
                        >
                            {titles.get(session.id) ?? session.title}
                        </button>
                    ))}
                </nav>
                <div className="mt-3 space-y-2 border-t border-border pt-3">{botActions}</div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 text-sm font-medium">
                    <span>{bot.displayName}</span>
                    {runtime.kind === "ready" && runtime.models.length > 0 && (
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
                        <LoaderCircle className="size-4 animate-spin" /> Connecting to Agent…
                    </p>
                )}
                {runtime.kind === "failed" && (
                    <p className="m-auto" role="alert">
                        {runtime.message}
                    </p>
                )}
                {runtime.kind === "ready" && (
                    <>
                        <LocalAgentTranscript
                            messages={messages}
                            turn={turn}
                            historyError={historyError}
                            readImage={readImage}
                        >
                            <LocalAgentInteractions
                                interaction={interaction}
                                elicitationValues={elicitationValues}
                                setElicitationValues={setElicitationValues}
                                answerPermission={answerPermission}
                                answerElicitation={answerElicitation}
                            />
                        </LocalAgentTranscript>
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
                                    placeholder="Ask Agent…"
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
            <LocalAgentSessionsDialog
                entries={nativeEntries}
                onClose={() => setNativeEntries(null)}
                onImport={importSession}
            />
        </main>
    );
}
