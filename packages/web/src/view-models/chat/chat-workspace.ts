import type { BotChatApi, ChatDraftConfiguration } from "../../services/chat/bot-chat-api.ts";
import { reportApplicationError } from "../report-error.ts";
import { createBotChatHomeStore } from "./bot-chat-home-store.ts";
import { createConversationDirectoryStore } from "./conversation-directory-store.ts";
import type { SelectedConversationTarget } from "./conversation-selection-machine.ts";
import { selectedConversationId, transitionConversationSelection } from "./conversation-selection-machine.ts";
import { createConversationStatusStore } from "./conversation-status-store.ts";
import { createDraftControlsStore } from "./draft-controls-store.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";

export interface ChatWorkspace {
    /** The chat API this workspace was composed with. */
    readonly requests: BotChatApi;
    readonly home: ReturnType<typeof createBotChatHomeStore>;
    readonly directory: ReturnType<typeof createConversationDirectoryStore>;
    readonly statuses: ReturnType<typeof createConversationStatusStore>;
    /** Harness and working-directory settings for the next draft message. */
    readonly draftControls: ReturnType<typeof createDraftControlsStore>;
    /** Restarts the draft settings load, for example from its retry control. */
    readonly retryDraftControls: () => void;
    /**
     * Announced with the chat view's attached root element, following React's
     * ref-cleanup protocol: the view hands it straight to its root element's
     * ref and the returned function re-arms the announcement. A ready
     * selection is re-read from the service — the same path as a fresh page
     * load — so a re-attached pane does not render a stale session snapshot
     * captured when the conversation was created or first opened.
     */
    readonly onAttach: (node: HTMLElement) => () => void;
    /** Restarts the directory load, for example from the sidebar refresh button. */
    readonly refreshDirectory: () => void;
    /** Reports a session activity change from an open session pane. */
    readonly sessionStatusChanged: (sessionId: string, status: SessionActivityState) => void;
    /** The signal of the current home loading attempt; aborted when loading restarts. */
    readonly chatSignal: () => AbortSignal;
    /** A stable signal for user-triggered operations such as archiving and diagnostics. */
    readonly operationsSignal: () => AbortSignal;
    readonly dispose: () => void;
}

function historyNavigation() {
    const replace = (modify: (url: URL) => void): void => {
        const url = new URL(window.location.href);
        modify(url);
        window.history.replaceState(window.history.state, "", url);
    };
    return {
        showContinuedSession: (sessionId: string) =>
            replace((url) => {
                url.searchParams.delete("harness");
                url.searchParams.delete("nativeSessionAction");
                url.searchParams.set("sessionId", sessionId);
            }),
        showDraft: () =>
            replace((url) => {
                url.searchParams.delete("conversation");
                url.searchParams.delete("conversationId");
                url.searchParams.delete("sessionId");
            }),
        showForkInstead: () =>
            replace((url) => {
                url.searchParams.set("nativeSessionAction", "fork");
            }),
        showManaged: (_isExternal: boolean, id: string) =>
            replace((url) => {
                url.searchParams.delete("conversationId");
                url.searchParams.set("sessionId", id);
            }),
    };
}

/**
 * Composes the chat screen's collaborating stores — home selection, the
 * conversation directory, and conversation statuses — and owns their loading
 * lifetimes outside React. The home store's revision counters are the restart
 * signals; this workspace observes them through store subscriptions, so a
 * restart cancels the previous attempt without any component effect.
 */
export function createChatWorkspace(options: {
    readonly botId: string;
    readonly requests: BotChatApi;
    readonly url?: string;
}): ChatWorkspace {
    const botId = options.botId;
    const requests = options.requests;
    const home = createBotChatHomeStore(requests, {
        botId,
        createId: () => crypto.randomUUID(),
        navigation: historyNavigation(),
        url: options.url ?? window.location.href,
    });
    const directory = createConversationDirectoryStore(botId, requests);
    const statuses = createConversationStatusStore(requests);
    const draftControls = createDraftControlsStore(botId, requests, (settings: ChatDraftConfiguration | null) => {
        home.setState({ draftSettings: settings });
    });

    let chatLifetime = new AbortController();
    chatLifetime.abort(new Error("The chat workspace has not loaded yet."));
    let directoryLifetime = new AbortController();
    directoryLifetime.abort(new Error("The chat workspace has not loaded yet."));
    const operationsLifetime = new AbortController();
    const statusLifetime = new AbortController();

    const startHomeLoad = (): void => {
        chatLifetime.abort(new Error("Chat loading restarted."));
        chatLifetime = new AbortController();
        const signal = chatLifetime.signal;
        void home
            .getState()
            .load(signal)
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "chat-home-load");
                }
            });
        void draftControls
            .getState()
            .load(signal)
            .catch(() => undefined);
    };
    const startDirectoryLoad = (): void => {
        directoryLifetime.abort(new Error("Directory loading restarted."));
        directoryLifetime = new AbortController();
        void directory
            .getState()
            .load(directoryLifetime.signal)
            .catch(() => undefined);
    };
    const announcedViews = new WeakSet<HTMLElement>();
    const loadSelectedSession = (target: SelectedConversationTarget): void => {
        const sessionId = target.kind === "conversation" ? target.conversationId : target.sessionId;
        void requests
            .managedSession(botId, sessionId, chatLifetime.signal)
            .then((session) => {
                const current = home.getState().selection;
                if (
                    !chatLifetime.signal.aborted &&
                    current.kind === "loading" &&
                    current.target.kind !== "continue" &&
                    selectedConversationId(current) === sessionId
                ) {
                    home.setState((state) => ({
                        selection: transitionConversationSelection(state.selection, {
                            kind: "session-loaded",
                            session,
                            target,
                        }),
                    }));
                }
            })
            .catch(() => undefined);
    };
    const announceChatViewAttached = (node: HTMLElement): (() => void) => {
        if (announcedViews.has(node)) {
            return () => {};
        }
        announcedViews.add(node);
        const selection = home.getState().selection;
        if (selection.kind === "loading" && selection.target.kind !== "continue") {
            // The previous view released this selection when it detached; the
            // re-attached view re-reads it exactly like a fresh page load.
            loadSelectedSession(selection.target);
        }
        return () => {
            announcedViews.delete(node);
            // A chat view detaching releases its ready selection so the next
            // attached view re-reads the session instead of rendering the
            // snapshot captured by the view instance that just went away.
            const current = home.getState().selection;
            if (current.kind === "ready") {
                home.setState((state) => ({
                    selection: transitionConversationSelection(state.selection, { kind: "reload-requested" }),
                }));
            }
        };
    };

    const initialSelection = home.getState().selection;
    const initialSelectionId = selectedConversationId(initialSelection);
    statuses.getState().selectionChanged(initialSelectionId.length > 0 ? initialSelectionId : null);
    let selectionKey: string | null = initialSelection.kind === "draft" ? initialSelection.key : null;

    const unsubscribeHome = home.subscribe((state, previous) => {
        if (state.revision !== previous.revision) {
            startHomeLoad();
        }
        if (state.revision !== previous.revision || state.directoryRevision !== previous.directoryRevision) {
            startDirectoryLoad();
        }
        const selectionId = selectedConversationId(state.selection);
        if (selectionId !== selectedConversationId(previous.selection)) {
            statuses.getState().selectionChanged(selectionId.length > 0 ? selectionId : null);
        }
        // A new draft (New Session) clears the home draft settings; the draft
        // controls republish them when their load restarts for the new draft.
        const draftKey = state.selection.kind === "draft" ? state.selection.key : null;
        if (draftKey !== null && draftKey !== selectionKey) {
            selectionKey = draftKey;
            void draftControls
                .getState()
                .load(chatLifetime.signal)
                .catch(() => undefined);
        }
    });
    const unsubscribeDirectory = directory.subscribe((state) => {
        if (state.state.kind === "ready") {
            statuses.getState().directoryLoaded(botId, state.state.sessions, statusLifetime.signal);
        }
    });

    startHomeLoad();
    startDirectoryLoad();

    return {
        requests,
        directory,
        home,
        statuses,
        draftControls,
        retryDraftControls: () => {
            void draftControls
                .getState()
                .load(chatLifetime.signal)
                .catch(() => undefined);
        },
        onAttach: announceChatViewAttached,
        refreshDirectory: startDirectoryLoad,
        sessionStatusChanged: (sessionId, status) =>
            statuses.getState().statusChanged(botId, sessionId, status, statusLifetime.signal),
        chatSignal: () => chatLifetime.signal,
        operationsSignal: () => operationsLifetime.signal,
        dispose: () => {
            unsubscribeHome();
            unsubscribeDirectory();
            chatLifetime.abort(new Error("The chat workspace was disposed."));
            directoryLifetime.abort(new Error("The chat workspace was disposed."));
            statusLifetime.abort(new Error("Conversation status lifetime ended."));
            operationsLifetime.abort(new Error("The chat workspace was disposed."));
            statuses.getState().close();
        },
    };
}
