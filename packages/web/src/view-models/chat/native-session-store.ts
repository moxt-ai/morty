import type { NativeSessionEntry, NativeSessionResult } from "@moxt-ai/mobius-sdk/channel";
import { createStore } from "zustand/vanilla";
import {
    type BotChatApi,
    type ChatAgentSelection,
    connectedChatRuntimeAgents,
} from "../../services/chat/bot-chat-api.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { type SessionMessage, sessionEventLogPresentation } from "./session-presentation.ts";

type NativeSessionDirectory =
    | { readonly kind: "loading" }
    | { readonly kind: "empty" }
    | {
          readonly kind: "ready";
          readonly runtimeId: string;
          readonly discoveryId: string;
          readonly agentRef: string;
          readonly capabilities: Extract<NativeSessionResult, { readonly action: "list" }>["capabilities"];
          readonly entries: readonly NativeSessionEntry[];
          readonly nextCursor: string | null;
      }
    | { readonly kind: "failed"; readonly message: string };

type NativeSessionPreview =
    | { readonly kind: "empty" }
    | { readonly kind: "loading"; readonly entry: NativeSessionEntry }
    | {
          readonly kind: "ready";
          readonly entry: NativeSessionEntry;
          readonly content: {
              readonly messages: readonly SessionMessage[];
              readonly truncated: boolean;
          };
      }
    | { readonly kind: "failed"; readonly entry: NativeSessionEntry; readonly message: string };

type Operation = "idle" | "more" | "import" | "fork";

export interface NativeSessionStore {
    readonly agents: readonly ChatAgentSelection[];
    readonly selected: string;
    readonly directory: NativeSessionDirectory;
    readonly preview: NativeSessionPreview;
    readonly operation: Operation;
    readonly error: string;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly selectAgent: (value: string) => void;
    readonly select: (entry: NativeSessionEntry, signal: AbortSignal) => Promise<void>;
    readonly open: (action: "import" | "fork", signal: AbortSignal) => Promise<void>;
    readonly more: (signal: AbortSignal) => Promise<void>;
    readonly dispose: () => void;
}

export const createNativeSessionStore = (
    botId: string,
    requests: Pick<BotChatApi, "workspace" | "nativeSessions" | "nativeSession">,
    onOpen: (session: OpenMobiusSession) => void,
) => {
    let selection: AbortController | null = null;
    return createStore<NativeSessionStore>()((set, get) => ({
        agents: [],
        selected: "",
        directory: { kind: "loading" },
        preview: { kind: "empty" },
        operation: "idle",
        error: "",
        load: async (signal) => {
            set({ directory: { kind: "loading" }, preview: { kind: "empty" }, error: "" });
            try {
                const workspace = await requests.workspace(botId, signal);
                signal.throwIfAborted();
                const agents = connectedChatRuntimeAgents(workspace.runtime);
                set({ agents });
                const selected = get().selected;
                const agent = agents.find((item) => `${item.runtimeId}:${item.agentRef}` === selected) ?? agents[0];
                if (agent === undefined) {
                    set({ directory: { kind: "empty" } });
                    return;
                }
                const result = await requests.nativeSessions(
                    botId,
                    agent.runtimeId,
                    {
                        action: "list",
                        agentId: agent.agentRef,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        cursor: null,
                        discoveryId: null,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                set({
                    directory: {
                        kind: "ready",
                        runtimeId: agent.runtimeId,
                        discoveryId: result.sessionId,
                        agentRef: agent.agentRef,
                        capabilities: result.capabilities,
                        entries: result.entries,
                        nextCursor: result.nextCursor,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        directory: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "Native sessions are unavailable.",
                        },
                        error: cause instanceof Error ? cause.message : "Native sessions are unavailable.",
                    });
                }
            }
        },
        selectAgent: (selected) => set({ selected }),
        select: async (entry, lifetimeSignal) => {
            const { directory, operation } = get();
            if (directory.kind !== "ready" || operation !== "idle") {
                return;
            }
            selection?.abort();
            selection = new AbortController();
            const signal = AbortSignal.any([selection.signal, lifetimeSignal]);
            set({ preview: { kind: "loading", entry }, error: "" });
            try {
                const content = await requests.nativeSession(
                    botId,
                    directory.runtimeId,
                    {
                        agentId: directory.agentRef,
                        directoryId: entry.directoryId,
                        additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                        entryId: entry.entryId,
                        nativeSessionId: entry.nativeSessionId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const events = [
                    ...content.history.events,
                    ...(content.executingPromptRequest === null ? [] : content.executingPromptRequest.events),
                ];
                set({
                    preview: {
                        kind: "ready",
                        entry,
                        content: {
                            messages: sessionEventLogPresentation(events).messages,
                            truncated: content.history.truncated || content.executingPromptRequest?.truncated === true,
                        },
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        preview: {
                            kind: "failed",
                            entry,
                            message: cause instanceof Error ? cause.message : "The preview could not be loaded.",
                        },
                        error: cause instanceof Error ? cause.message : "The preview could not be loaded.",
                    });
                }
            }
        },
        open: async (action, signal) => {
            const { directory, preview, operation } = get();
            if (directory.kind !== "ready" || preview.kind !== "ready" || operation !== "idle") {
                return;
            }
            set({ operation: action, error: "" });
            try {
                const result = await requests.nativeSessions(
                    botId,
                    directory.runtimeId,
                    {
                        action,
                        discoveryId: directory.discoveryId,
                        agentId: directory.agentRef,
                        directoryId: preview.entry.directoryId,
                        additionalDirectoryIds: preview.entry.additionalDirectories.map((item) => item.directoryId),
                        entryId: preview.entry.entryId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== action) {
                    throw new Error(`This agent cannot ${action} the selected native session.`);
                }
                onOpen({
                    agentRef: directory.agentRef,
                    result,
                    entry: preview.entry,
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: cause instanceof Error ? cause.message : `The session could not be ${action}ed.` });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                }
            }
        },
        more: async (signal) => {
            const { directory, operation } = get();
            if (directory.kind !== "ready" || directory.nextCursor === null || operation !== "idle") {
                return;
            }
            set({ operation: "more", error: "" });
            try {
                const result = await requests.nativeSessions(
                    botId,
                    directory.runtimeId,
                    {
                        action: "list",
                        agentId: directory.agentRef,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        cursor: directory.nextCursor,
                        discoveryId: directory.discoveryId,
                    },
                    signal,
                );
                signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("The agent returned an unexpected session directory.");
                }
                set({
                    directory: {
                        ...directory,
                        entries: [
                            ...directory.entries,
                            ...result.entries.filter(
                                (entry) => !directory.entries.some((existing) => existing.entryId === entry.entryId),
                            ),
                        ],
                        nextCursor: result.nextCursor,
                    },
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({ error: cause instanceof Error ? cause.message : "More sessions could not be loaded." });
                }
            } finally {
                if (!signal.aborted) {
                    set({ operation: "idle" });
                }
            }
        },
        dispose: () => {
            selection?.abort();
            selection = null;
        },
    }));
};
