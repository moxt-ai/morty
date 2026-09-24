import { createStore } from "zustand/vanilla";
import type { BotChatApi, ManagedChatSession } from "@/services/chat/bot-chat-api";
import { CloudApiError } from "@/services/management/management-api";

type ConversationDirectoryState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "refreshing"; readonly sessions: readonly ManagedChatSession[] }
    | { readonly kind: "setup-required" }
    | { readonly kind: "stale"; readonly sessions: readonly ManagedChatSession[]; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

type ArchiveOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "archiving"; readonly sessionId: string }
    | { readonly kind: "failed"; readonly message: string; readonly sessionId: string };

export interface ConversationDirectoryStore {
    readonly state: ConversationDirectoryState;
    readonly archive: ArchiveOperation;
    readonly archiveSession: (sessionId: string, signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal) => Promise<void>;
}

export const createConversationDirectoryStore = (
    botId: string,
    requests: Pick<BotChatApi, "archiveManagedSession" | "managedSessions">,
) =>
    createStore<ConversationDirectoryStore>()((set, get) => ({
        state: { kind: "loading" },
        archive: { kind: "idle" },
        archiveSession: async (sessionId, signal) => {
            set({ archive: { kind: "archiving", sessionId } });
            try {
                await requests.archiveManagedSession(botId, sessionId, signal);
                signal.throwIfAborted();
                set((current) => {
                    const state = current.state;
                    switch (state.kind) {
                        case "ready":
                            return {
                                archive: { kind: "idle" },
                                state: {
                                    kind: "ready",
                                    sessions: state.sessions.filter((session) => session.id !== sessionId),
                                },
                            };
                        case "refreshing":
                            return {
                                archive: { kind: "idle" },
                                state: {
                                    kind: "refreshing",
                                    sessions: state.sessions.filter((session) => session.id !== sessionId),
                                },
                            };
                        case "stale":
                            return {
                                archive: { kind: "idle" },
                                state: {
                                    kind: "stale",
                                    message: state.message,
                                    sessions: state.sessions.filter((session) => session.id !== sessionId),
                                },
                            };
                        case "loading":
                        case "setup-required":
                        case "failed":
                            return { archive: { kind: "idle" }, state };
                    }
                });
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        archive: {
                            kind: "failed",
                            sessionId,
                            message: cause instanceof Error ? cause.message : "The conversation could not be archived.",
                        },
                    });
                }
            }
        },
        load: async (signal) => {
            const current = get().state;
            const cached =
                current.kind === "ready" || current.kind === "refreshing" || current.kind === "stale"
                    ? current.sessions
                    : null;
            set({ state: cached === null ? { kind: "loading" } : { kind: "refreshing", sessions: cached } });
            try {
                const sessions = await requests.managedSessions(botId, signal);
                signal.throwIfAborted();
                set({ state: { kind: "ready", sessions } });
            } catch (cause) {
                if (!signal.aborted) {
                    if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                        set({ state: { kind: "setup-required" } });
                        return;
                    }
                    const message = cause instanceof Error ? cause.message : "Conversations are unavailable.";
                    set({
                        state:
                            cached === null
                                ? { kind: "failed", message }
                                : { kind: "stale", message, sessions: cached },
                    });
                }
            }
        },
    }));
