import {
    MobiusApiError,
    type MobiusSession,
    type SessionConfigOption,
    type SessionReadyEvent,
    type WorkspaceEntry,
} from "@moxt-ai/mobius-sdk";
import { createStore } from "zustand/vanilla";
import { readBotConversationSession, updateBotConversationWorkspace } from "@/services/bots/bot-api";
import { configureConversationSession, prepareConversationSession } from "@/services/chat/mobius-transport";
import type { ChannelConnection } from "@/view-models/chat/channel";

type BotComposerSessionState =
    | { readonly kind: "loading"; readonly statusLabel: "Preparing local agent…" }
    | {
          readonly kind: "preparing";
          readonly directoryLabel: string;
          readonly session: MobiusSession;
          readonly statusLabel: "Preparing local agent…";
      }
    | {
          readonly kind: "ready";
          readonly ready: SessionReadyEvent;
          readonly session: MobiusSession;
          readonly statusLabel: "Local agent ready";
      }
    | { readonly kind: "failed"; readonly message: string; readonly statusLabel: "Local agent unavailable" }
    | {
          readonly kind: "prepared-failed";
          readonly directoryLabel: string;
          readonly message: string;
          readonly session: MobiusSession;
          readonly statusLabel: "Local agent unavailable";
      };

export interface ConversationSessionStore {
    readonly configuring: boolean;
    readonly state: BotComposerSessionState;
    readonly configure: (
        option: SessionConfigOption,
        value: string,
        booleanValue: boolean,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly prepare: (sessionId: string, signal: AbortSignal) => Promise<void>;
    readonly selectWorkspace: (directory: WorkspaceEntry, locked: boolean, signal: AbortSignal) => Promise<void>;
}

function failureMessage(error: unknown): string {
    if (error instanceof MobiusApiError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : "The conversation request failed.";
}

export const createConversationSessionStore = (connection: ChannelConnection) =>
    createStore<ConversationSessionStore>()((set, get) => ({
        configuring: false,
        state: { kind: "loading", statusLabel: "Preparing local agent…" },
        configure: async (option, value, booleanValue, lifetimeSignal) => {
            const state = get();
            if (state.state.kind !== "ready") {
                return "The local Bot session is not ready.";
            }
            if (state.configuring) {
                return "Wait for the current session setting to finish.";
            }
            const active = state.state;
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            set({ configuring: true });
            try {
                const configured = await configureConversationSession(
                    {
                        additionalDirectoryIds: [],
                        agentId: active.session.defaultBinding.agentRef,
                        bindingId: active.session.defaultBinding.bindingId,
                        booleanValue,
                        configId: option.id,
                        directoryId: active.session.defaultBinding.workspaceRef,
                        sessionId: active.session.sessionId,
                        value,
                        valueType: option.type,
                    },
                    signal,
                );
                const session = await readBotConversationSession(connection, active.session.sessionId, signal);
                signal.throwIfAborted();
                const current = get().state;
                if (current.kind === "ready" && current.session.sessionId === active.session.sessionId) {
                    set({
                        state: {
                            ...current,
                            ready: { ...current.ready, configOptions: configured.configOptions },
                            session,
                        },
                    });
                }
                return "";
            } catch (error) {
                return failureMessage(error);
            } finally {
                if (!lifetimeSignal.aborted) {
                    set({ configuring: false });
                }
            }
        },
        prepare: async (sessionId, lifetimeSignal) => {
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            set({ state: { kind: "loading", statusLabel: "Preparing local agent…" } });
            try {
                const session = await readBotConversationSession(connection, sessionId, signal);
                set({
                    state: {
                        directoryLabel: session.defaultBinding.workspaceRef,
                        kind: "preparing",
                        session,
                        statusLabel: "Preparing local agent…",
                    },
                });
                const ready = await prepareConversationSession(
                    {
                        additionalDirectoryIds: [],
                        agentId: session.defaultBinding.agentRef,
                        bindingId: session.defaultBinding.bindingId,
                        directoryId: session.defaultBinding.workspaceRef,
                        requestId: `bot-prepare-${crypto.randomUUID()}`,
                        sessionId: session.sessionId,
                    },
                    signal,
                );
                const refreshed = await readBotConversationSession(connection, session.sessionId, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", ready, session: refreshed, statusLabel: "Local agent ready" } });
            } catch (error) {
                if (!lifetimeSignal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: failureMessage(error),
                            statusLabel: "Local agent unavailable",
                        },
                    });
                }
            }
        },
        selectWorkspace: async (directory, locked, lifetimeSignal) => {
            const state = get().state;
            if (state.kind !== "ready" || locked || get().configuring) {
                throw new Error("The workspace is fixed after the first message");
            }
            const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(120_000)]);
            let session = state.session;
            set({
                state: {
                    directoryLabel: directory.name,
                    kind: "preparing",
                    session,
                    statusLabel: "Preparing local agent…",
                },
            });
            try {
                session = await updateBotConversationWorkspace(connection, session, directory.directoryId, signal);
                const ready = await prepareConversationSession(
                    {
                        additionalDirectoryIds: [],
                        agentId: session.defaultBinding.agentRef,
                        bindingId: session.defaultBinding.bindingId,
                        directoryId: session.defaultBinding.workspaceRef,
                        sessionId: session.sessionId,
                    },
                    signal,
                );
                session = await readBotConversationSession(connection, session.sessionId, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", ready, session, statusLabel: "Local agent ready" } });
            } catch (error) {
                const message = failureMessage(error);
                if (!lifetimeSignal.aborted) {
                    set({
                        state: {
                            directoryLabel: directory.name,
                            kind: "prepared-failed",
                            message,
                            session,
                            statusLabel: "Local agent unavailable",
                        },
                    });
                }
                throw error;
            }
        },
    }));
