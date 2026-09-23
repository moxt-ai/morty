import type {
    NativeHistoryMessage,
    NativeSessionEntry,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-protocol";
import type { MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import type { PendingInteraction } from "./local-agent-interactions.tsx";
import type { TurnState } from "./local-agent-transcript.tsx";

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

export function useLocalAgentChat({
    bot,
    requests,
}: {
    readonly bot: ManagedBot;
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

    return {
        runtime,
        sessions,
        selectedId,
        titles,
        messages,
        historyError,
        draft,
        setDraft,
        selectedModel,
        setSelectedModel,
        turn,
        setTurn,
        interaction,
        elicitationValues,
        setElicitationValues,
        nativeEntries,
        setNativeEntries,
        open,
        newChat,
        send,
        browse,
        importSession,
        readImage,
        answerPermission,
        answerElicitation,
    };
}
