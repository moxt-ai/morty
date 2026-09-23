import type {
    NativeHistoryMessage,
    NativeSessionEntry,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-protocol";
import {
    AGENT_MESSAGE_DELTA_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PROMPT_KIND,
} from "@moxt-ai/mobius-protocol";
import type { MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BotChatApi, ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { createLocalHistoryStore } from "../../view-models/chat/local-history-store.ts";
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
const LIVE_TEXT_LIMIT = 100_000;
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
): Promise<{ readonly messages: readonly NativeHistoryMessage[]; readonly truncated: boolean }> {
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
    return { messages: result.history.messages, truncated: result.history.truncated };
}

async function localActiveTurn(
    client: MobiusChannelClient,
    botId: string,
    agentRef: string,
    session: ManagedChatSession,
    signal: AbortSignal,
) {
    const result = await client.manageNativeSession(
        {
            ...nativeRequest(botId, agentRef, crypto.randomUUID()),
            directoryId: session.directoryId,
            additionalDirectoryIds: session.additionalDirectoryIds,
            action: "active-turn",
            targetSessionId: session.id,
        },
        signal,
    );
    if (result.action !== "active-turn") {
        throw new Error("The Runtime returned an invalid active Turn.");
    }
    return result.turn;
}

export function useLocalAgentChat({
    bot,
    requests,
    routeSessionId,
    selectRouteSession,
}: {
    readonly bot: ManagedBot;
    readonly routeSessionId: string | null;
    readonly selectRouteSession: (sessionId: string) => void;
    readonly requests: Pick<
        BotChatApi,
        "localRuntime" | "localSessions" | "createLocalSession" | "connectLocalRuntime" | "agentSettings"
    >;
}) {
    const [runtime, setRuntime] = useState<RuntimeState>({ kind: "connecting" });
    const [sessions, setSessions] = useState<readonly ManagedChatSession[]>([]);
    const [historyStore] = useState(createLocalHistoryStore);
    const routeSessionRef = useRef(routeSessionId);
    routeSessionRef.current = routeSessionId;
    const selectRouteRef = useRef(selectRouteSession);
    selectRouteRef.current = selectRouteSession;
    const { state: history } = useStore(historyStore);
    const selectedId = history.kind === "none" ? null : history.sessionId;
    const data =
        history.kind === "ready" || history.kind === "refreshing" || history.kind === "failed" ? history.data : null;
    const messages = data === null ? [] : data.messages.slice(-data.visibleCount);
    const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [operationError, setOperationError] = useState<string | null>(null);
    const historyError = history.kind === "failed" ? history.message : operationError;
    const [draft, setDraft] = useState("");
    const [selectedModel, setSelectedModel] = useState("");
    const [turn, setTurn] = useState<TurnState>({ kind: "idle" });
    const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
    const [elicitationValues, setElicitationValues] = useState<Readonly<Record<string, string>>>({});
    const [nativeEntries, setNativeEntries] = useState<readonly NativeSessionEntry[] | null>(null);
    const lifetime = useRef<AbortController | null>(null);
    const connectionRef = useRef<{ readonly client: MobiusChannelClient; readonly agentRef: string } | null>(null);
    const historyRequest = useRef<{
        readonly sessionId: string;
        readonly controller: AbortController;
        readonly completion: Promise<void>;
    } | null>(null);
    const activeRequest = useRef<AbortController | null>(null);
    const onlineRef = useRef(false);
    const refreshActiveTurn = useCallback(
        async (client: MobiusChannelClient, agentRef: string, sessionId: string, parent: AbortSignal) => {
            activeRequest.current?.abort(new Error("Another active Turn was requested"));
            const controller = new AbortController();
            activeRequest.current = controller;
            const signal = AbortSignal.any([parent, controller.signal]);
            try {
                const session = (await requests.localSessions(bot.botId, signal)).find((item) => item.id === sessionId);
                if (session === undefined) {
                    return;
                }
                const snapshot = await localActiveTurn(client, bot.botId, agentRef, session, signal);
                signal.throwIfAborted();
                const selected = historyStore.getState().state;
                if (selected.kind === "none" || selected.sessionId !== sessionId || snapshot === null) {
                    return;
                }
                setTurn((current) => {
                    if (current.kind === "running" && current.commandId !== snapshot.commandId) {
                        return current;
                    }
                    return {
                        kind: "running",
                        commandId: snapshot.commandId,
                        sessionId,
                        prompt: snapshot.prompt,
                        text: snapshot.text,
                        truncated: snapshot.truncated,
                    };
                });
            } catch (error) {
                if (!signal.aborted) {
                    setOperationError(failureMessage(error));
                }
            } finally {
                if (activeRequest.current === controller) {
                    activeRequest.current = null;
                }
            }
        },
        [bot.botId, historyStore, requests],
    );
    const refreshHistory = useCallback(
        async (client: MobiusChannelClient, agentRef: string, sessionId: string, parent: AbortSignal) => {
            const previous = historyRequest.current;
            if (previous?.sessionId === sessionId) {
                await previous.completion;
                return;
            }
            previous?.controller.abort(new Error("Another Session was selected"));
            const controller = new AbortController();
            const signal = AbortSignal.any([parent, controller.signal]);
            const completion = (async () => {
                await previous?.completion;
                if (signal.aborted) {
                    return;
                }
                const revision = historyStore.getState().begin(sessionId);
                if (revision === null) {
                    return;
                }
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
                    historyStore.getState().complete(sessionId, revision, history);
                    const firstPrompt = history.messages.find((message) => message.role === "user")?.text.trim();
                    if (firstPrompt) {
                        setTitles((current) => new Map(current).set(sessionId, firstPrompt.slice(0, 60)));
                    }
                } catch (error) {
                    if (!signal.aborted) {
                        historyStore.getState().fail(sessionId, revision, failureMessage(error));
                    }
                }
            })();
            const current = { sessionId, controller, completion };
            historyRequest.current = current;
            try {
                await completion;
            } finally {
                if (historyRequest.current === current) {
                    historyRequest.current = null;
                }
            }
        },
        [bot.botId, historyStore, requests],
    );

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setRuntime({ kind: "connecting" });
        historyStore.getState().select(null);
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
                    onLiveMessage: (message) => {
                        const selected = historyStore.getState().state;
                        if (selected.kind === "none" || selected.sessionId !== message.sessionId) {
                            return;
                        }
                        switch (message.kind) {
                            case SESSION_PROMPT_KIND:
                                setTurn((current) =>
                                    current.kind === "running" && current.commandId === message.commandId
                                        ? current
                                        : {
                                              kind: "running",
                                              commandId: message.commandId,
                                              sessionId: message.sessionId,
                                              prompt: message.prompt,
                                              text: "",
                                              truncated: false,
                                          },
                                );
                                return;
                            case AGENT_MESSAGE_DELTA_KIND:
                                setTurn((current) =>
                                    current.kind === "running" && current.commandId === message.commandId
                                        ? {
                                              ...current,
                                              text: (current.text + message.text).slice(-LIVE_TEXT_LIMIT),
                                              truncated:
                                                  current.truncated ||
                                                  current.text.length + message.text.length > LIVE_TEXT_LIMIT,
                                          }
                                        : current,
                                );
                                return;
                            case SESSION_COMPLETED_KIND: {
                                const connection = connectionRef.current;
                                if (connection !== null) {
                                    void refreshHistory(
                                        connection.client,
                                        connection.agentRef,
                                        message.sessionId,
                                        controller.signal,
                                    );
                                }
                                setTurn((current) =>
                                    current.kind === "running" && current.commandId === message.commandId
                                        ? { kind: "idle" }
                                        : current,
                                );
                                return;
                            }
                            case SESSION_FAILED_KIND:
                                setTurn((current) =>
                                    current.kind === "running" && current.commandId === message.commandId
                                        ? { kind: "unknown", prompt: current.prompt, message: message.message }
                                        : current,
                                );
                                return;
                            default: {
                                const remaining: never = message;
                                return remaining;
                            }
                        }
                    },
                    onPermission: (request) => {
                        const selected = historyStore.getState().state;
                        if (selected.kind !== "none" && request.sessionId === selected.sessionId) {
                            setInteraction({ kind: "permission", request });
                        }
                    },
                    onPermissionResolved: (resolved) => {
                        setInteraction((current) =>
                            current?.request.interactionId === resolved.interactionId ? null : current,
                        );
                    },
                    onElicitation: (request) => {
                        const selected = historyStore.getState().state;
                        if (selected.kind !== "none" && request.sessionId === selected.sessionId) {
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
                        const current = historyStore.getState().state;
                        const selected = current.kind === "none" ? null : current.sessionId;
                        const connection = connectionRef.current;
                        if (reconnected && selected !== null && connection !== null) {
                            void refreshActiveTurn(connection.client, connection.agentRef, selected, controller.signal);
                            void refreshHistory(connection.client, connection.agentRef, selected, controller.signal);
                        }
                    },
                });
                controller.signal.throwIfAborted();
                connectionRef.current = { client, agentRef: configuration.agentRef };
                onlineRef.current = true;
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
                const initial =
                    saved.find((session) => session.id === routeSessionRef.current)?.id ?? saved[0]?.id ?? null;
                historyStore.getState().select(initial);
                if (initial !== null) {
                    if (initial !== routeSessionRef.current) {
                        selectRouteRef.current(initial);
                    }
                    void refreshActiveTurn(client, configuration.agentRef, initial, controller.signal);
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
            historyRequest.current?.controller.abort();
            activeRequest.current?.abort();
            connectionRef.current = null;
            onlineRef.current = false;
            if (lifetime.current === controller) {
                lifetime.current = null;
            }
        };
    }, [bot.botId, historyStore, refreshActiveTurn, refreshHistory, requests]);

    const loadSession = useCallback(
        async (session: ManagedChatSession) => {
            if (runtime.kind !== "ready" || lifetime.current === null) {
                return;
            }
            const sessionId = session.id;
            historyStore.getState().select(sessionId);
            setOperationError(null);
            setTurn({ kind: "idle" });
            setInteraction(null);
            void refreshActiveTurn(runtime.client, runtime.agentRef, sessionId, lifetime.current.signal);
            await refreshHistory(runtime.client, runtime.agentRef, sessionId, lifetime.current.signal);
        },
        [historyStore, refreshActiveTurn, refreshHistory, runtime],
    );
    useEffect(() => {
        if (routeSessionId === null || runtime.kind !== "ready") {
            return;
        }
        const current = historyStore.getState().state;
        if (current.kind !== "none" && current.sessionId === routeSessionId) {
            return;
        }
        const session = sessions.find((item) => item.id === routeSessionId);
        if (session !== undefined) {
            void loadSession(session);
        }
    }, [historyStore, loadSession, routeSessionId, runtime, sessions]);
    const open = async (session: ManagedChatSession) => {
        selectRouteSession(session.id);
        await loadSession(session);
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
            setOperationError(failureMessage(error));
            return null;
        }
    };
    const send = async () => {
        if (
            runtime.kind !== "ready" ||
            !runtime.online ||
            lifetime.current === null ||
            draft.trim().length === 0 ||
            (history.kind !== "ready" && history.kind !== "none") ||
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
        setTurn({ kind: "running", commandId, sessionId, prompt, text: "", truncated: false });
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
            });
            if (lifetime.current !== null) {
                await refreshHistory(runtime.client, runtime.agentRef, sessionId, lifetime.current.signal);
            }
            setTurn((current) =>
                current.kind === "running" && current.commandId === commandId ? { kind: "idle" } : current,
            );
        } catch (error) {
            const current = historyStore.getState().state;
            if (current.kind !== "none" && current.sessionId === sessionId) {
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
            setOperationError(failureMessage(error));
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
            setOperationError(failureMessage(error));
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
            setOperationError(failureMessage(error));
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
            setOperationError(failureMessage(error));
        }
    };

    return {
        runtime,
        sessions,
        selectedId,
        titles,
        messages,
        history,
        loadMore: historyStore.getState().loadMore,
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
