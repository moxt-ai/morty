import type { StoreApi } from "zustand/vanilla";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, type IdentityScope } from "../../services/identity/identity-scope-url.ts";
import { rememberComputerName, rememberComputerVisit } from "../../services/identity/remembered-computers.ts";
import { isRuntimeConnectionFailure } from "../../services/management/management-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { BugReportDialogStore } from "../bug-report-dialog-store.ts";
import { formatError } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import { type BotChatHomeStoreApi, createBotChatHomeStore, homeWaitsForRuntime } from "./bot-chat-home-store.ts";
import { createComposerAttachmentStore } from "./composer-attachment-store.ts";
import type { ComputerSwitcherModel } from "./computer-switcher-store.ts";
import { type ConversationDirectoryStore, createConversationDirectoryStore } from "./conversation-directory-store.ts";
import type { ConversationSelectionState, SelectedConversationTarget } from "./conversation-selection-machine.ts";
import { selectedConversationId, transitionConversationSelection } from "./conversation-selection-machine.ts";
import { type ConversationStatusStoreApi, createConversationStatusStore } from "./conversation-status-store.ts";
import { createDraftControlsStore, type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { createNetworkDiagnosticStore, type NetworkDiagnosticStore } from "./network-diagnostic-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { createRemoteAccessStore, type RemoteAccessStore } from "./remote-access-store.ts";
import { createRuntimeRecovery } from "./runtime-recovery.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";
import { createSessionDeliveryStore } from "./session-delivery-store.ts";
import { createSessionPaneModel, type SessionPaneModel } from "./session-pane-store.ts";
import { createSidebarDialogs, type SidebarDialogs } from "./sidebar-dialogs.ts";

interface ChatWorkspaceSidebar {
    readonly dialogs: SidebarDialogs;
    readonly remoteAccess: StoreApi<RemoteAccessStore>;
    readonly networkDiagnostic: StoreApi<NetworkDiagnosticStore>;
}

interface ChatWorkspacePaneEntry {
    readonly session: OpenMobiusSession;
    readonly model: SessionPaneModel;
}

export interface ChatWorkspace {
    readonly computers: ComputerSwitcherModel | null;
    readonly accessNotice: string | null;
    /** The chat API this workspace was composed with. */
    readonly requests: BotChatApi;
    /** The application-owned bug-report dialog state, flowing to entry points. */
    readonly bugReportDialog: BugReportDialogStore;
    /** The Bot this workspace talks to; also scopes diagnostics sources. */
    readonly botId: string;
    /** The project location label source for the sidebar, when known. */
    readonly projectId: string | null;
    readonly home: BotChatHomeStoreApi;
    readonly directory: StoreApi<ConversationDirectoryStore>;
    readonly statuses: ConversationStatusStoreApi;
    /** Harness and working-directory settings for the next draft message. */
    readonly draftControls: StoreApi<DraftControlsStore>;
    /** Sidebar ephemeral UI and dialog stores; lives outside React with this workspace. */
    readonly sidebar: ChatWorkspaceSidebar;
    /**
     * The session pane model for the currently selected conversation, created
     * by the workspace when the selection becomes ready for a fresh session
     * record and released when it moves on. Render-time access is a pure
     * read: `null` means the pane for the ready selection is not built (yet),
     * which no current view renders through.
     */
    readonly sessionPane: () => SessionPaneModel | null;
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
    /** Records deliberate activity in this tab without following another tab's selection. */
    readonly recordUserActivity: () => void;
    /** Starts the workspace's loads; the application calls this when it activates the workspace. */
    readonly start: () => void;
    readonly dispose: () => void;
}

function historyNavigation(onDraft: () => void) {
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
        showDraft: () => {
            onDraft();
            replace((url) => {
                url.searchParams.delete("conversation");
                url.searchParams.delete("conversationId");
                url.searchParams.delete("sessionId");
            });
        },
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
 * lifetimes outside React. The home store announces restarts and pane replacements
 * through explicit port callbacks, so a restart cancels the previous attempt
 * without any component effect.
 */
export function createChatWorkspace(options: {
    readonly clock: Clock;
    readonly botId: string;
    readonly rememberedIdentity?: IdentityScope;
    readonly computers?: ComputerSwitcherModel;
    readonly accessNotice?: string | null;
    readonly entry?: "address" | "restore";
    readonly bugReportDialog: BugReportDialogStore;
    readonly projectId?: string;
    readonly requests: BotChatApi;
    readonly url?: string;
    readonly createTransfer?: ((signal: AbortSignal) => Promise<IdentityTransfer>) | undefined;
    readonly currentAccessToken?: ((signal: AbortSignal) => Promise<string>) | undefined;
    readonly endRemoteAccess?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly networkDiagnostics?: {
        readonly measureBrowserMobius: (origin: string, signal: AbortSignal) => Promise<number>;
        readonly measureBrowserMorty: (signal: AbortSignal) => Promise<number>;
    };
}): ChatWorkspace {
    const botId = options.botId;
    const requests = options.requests;
    let rememberedSessionId: string | null = null;
    let initialVisitPending = true;
    const recordHome = () => {
        rememberedSessionId = null;
        if (options.rememberedIdentity !== undefined) {
            rememberComputerVisit(options.rememberedIdentity, options.clock.now(), { kind: "home" });
        }
    };
    const home = createBotChatHomeStore(requests, {
        botId,
        identityKey: options.rememberedIdentity === undefined ? null : encodeIdentityScope(options.rememberedIdentity),
        draftConfiguration: () => draftConfiguration(draftControls.getState().settings),
        now: options.clock.now,
        onRuntimeConfigurationUnavailable: () => options.computers?.invalidateCurrent(),
        onWaitingForRuntime: () => runtimeRecovery.failed(),
        createId: () => crypto.randomUUID(),
        navigation: historyNavigation(recordHome),
        entry: options.entry ?? "address",
        onRuntimeConfiguration: (configuration, observation) => {
            options.computers?.updateCurrent(configuration);
            sidebar.dialogs.getState().runtimeChanged();
            void draftControls
                .getState()
                .runtimeChanged(configuration, chatLifetime.signal)
                .catch(() => undefined);
            if (initialVisitPending) {
                initialVisitPending = false;
                if (home.getState().selection.kind === "draft") {
                    recordHome();
                }
            }
            if (options.rememberedIdentity !== undefined) {
                rememberComputerName(options.rememberedIdentity, configuration.runtime.machineName);
            }
            runtimeRecovery.observe(configuration.runtime.online, observation);
        },
        onDraftSelected: () => {
            void draftControls
                .getState()
                .load(chatLifetime.signal)
                .catch(() => undefined);
        },
        onRestart: () => {
            startHomeLoad();
            startDirectoryLoad();
        },
        onDirectoryRefreshed: () => startDirectoryLoad(),
        onConversationCreated: (conversationId, title) =>
            directory.getState().conversationCreated(conversationId, title),
        onSelectionReady: (selection) => {
            runtimeRecovery.working();
            replacePane(selection);
        },
        onSelectionTargeted: (conversationId) => statuses.getState().selectionChanged(conversationId),
        url: options.url ?? window.location.href,
    });
    const directory = createConversationDirectoryStore(
        botId,
        requests,
        (sessions) => {
            statuses.getState().directoryLoaded(botId, sessions, statusLifetime.signal);
            sidebar.dialogs.getState().nativeDialog?.getState().titlesChanged();
        },
        options.clock,
        (sessionId) => {
            if (selectedConversationId(home.getState().selection) !== sessionId) {
                return;
            }
            paneEntry?.model.stop();
            paneEntry = null;
            home.getState().newConversation();
        },
    );
    const statuses = createConversationStatusStore(
        requests,
        (sessionId, reason) => {
            // Only the open pane has something to tell its user; the other Sessions reopen when selected.
            if (paneEntry?.session.result.ready.sessionId === sessionId) {
                paneEntry.model.store.getState().sessionClosed(reason);
            }
        },
        () => runtimeRecovery.failed(),
        () => runtimeRecovery.working(),
    );
    const draftControls = createDraftControlsStore(
        botId,
        requests,
        () => home.getState().runtimeConfiguration,
        () => runtimeRecovery.failed(),
    );
    // Sidebar stores live with the workspace, outside React: dialogs (native
    // session import, identity sharing, expanded state), remote access, and
    // network diagnostics all outlive any single sidebar render.
    const sidebar: ChatWorkspaceSidebar = {
        dialogs: createSidebarDialogs({
            clock: options.clock,
            botId,
            requests,
            runtime: () => home.getState().runtimeConfiguration?.runtime ?? null,
            nativeSessionTitle: (entry) => {
                const current = directory.getState().state;
                const sessions =
                    current.kind === "ready" || current.kind === "refreshing" || current.kind === "stale"
                        ? current.sessions
                        : [];
                // Several Morty sessions can link to one native session; prefer the most recently updated title.
                const linked = sessions
                    .filter((session) => entry.mobiusSessionIds.includes(session.id) && session.title.trim().length > 0)
                    .sort(
                        (left, right) =>
                            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
                    );
                return linked[0]?.title ?? (entry.title || "Untitled session");
            },
            createTransfer: (signal) => {
                if (options.createTransfer === undefined) {
                    return Promise.reject(new Error("Identity sharing is unavailable."));
                }
                return options.createTransfer(signal);
            },
            onOpenSession: (session) => {
                home.getState().openManaged(session.result.action === "import", session.result.ready.sessionId);
            },
            onOpenedSession: () => startDirectoryLoad(),
        }),
        remoteAccess: createRemoteAccessStore({
            currentAccessToken: (signal) => {
                if (options.currentAccessToken === undefined) {
                    return Promise.reject(new Error("Remote access is unavailable."));
                }
                return options.currentAccessToken(signal);
            },
            endRemoteAccess: (signal) => {
                if (options.endRemoteAccess === undefined) {
                    return Promise.reject(new Error("Remote access is unavailable."));
                }
                return options.endRemoteAccess(signal);
            },
        }),
        networkDiagnostic: createNetworkDiagnosticStore({
            measureBrowserMobius: (origin, signal) => {
                if (options.networkDiagnostics === undefined) {
                    return Promise.reject(new Error("Network diagnostics are unavailable."));
                }
                return options.networkDiagnostics.measureBrowserMobius(origin, signal);
            },
            measureBrowserMorty: (signal) => {
                if (options.networkDiagnostics === undefined) {
                    return Promise.reject(new Error("Network diagnostics are unavailable."));
                }
                return options.networkDiagnostics.measureBrowserMorty(signal);
            },
            measureServerHops: (signal) => requests.networkDiagnostic(botId, signal),
        }),
    };
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
        // Harness settings belong to the draft composer; skip the
        // configuration burst when the entry targets an existing session. A
        // later new draft triggers the load through the onDraftSelected
        // announcement.
        if (home.getState().selection.kind === "draft") {
            void draftControls
                .getState()
                .load(signal)
                .catch(() => undefined);
        }
    };
    const startDirectoryLoad = (): void => {
        directoryLifetime.abort(new Error("Directory loading restarted."));
        directoryLifetime = new AbortController();
        const signal = directoryLifetime.signal;
        statuses.getState().directoryLoadStarted();
        void directory
            .getState()
            .load(signal)
            .catch(() => undefined)
            .finally(() => {
                if (signal.aborted) {
                    return;
                }
                if (listWaitsForRuntime()) {
                    runtimeRecovery.failed();
                } else {
                    runtimeRecovery.working();
                }
            });
    };
    const listWaitsForRuntime = (): boolean => {
        const listed = directory.getState().state.kind;
        return listed === "failed" || listed === "stale";
    };
    const draftWaitsForRuntime = (): boolean =>
        home.getState().selection.kind === "draft" && draftControls.getState().settings.kind === "waiting-runtime";
    /**
     * Retries everything the page reads through the Runtime that it could not read while the Runtime was unreachable:
     * the home view, the session list, and the stream that follows their statuses. Each retries only what it lost.
     * Restarting the home view reloads the list with it, and a list load follows the statuses again.
     */
    const runtimeRecovery = createRuntimeRecovery({
        clock: options.clock,
        lifetime: operationsLifetime.signal,
        waiting: () =>
            homeWaitsForRuntime(home.getState()) ||
            listWaitsForRuntime() ||
            statuses.getState().unfollowed() ||
            draftWaitsForRuntime(),
        retry: () => {
            if (homeWaitsForRuntime(home.getState())) {
                home.getState().retry();
            } else if (listWaitsForRuntime()) {
                startDirectoryLoad();
            } else if (statuses.getState().unfollowed()) {
                statuses.getState().follow(statusLifetime.signal);
            }
            // A late offline response can arrive after the online watch snapshot.
            // Draft settings need the same bounded recovery as the list and statuses.
            if (draftWaitsForRuntime()) {
                void draftControls
                    .getState()
                    .load(chatLifetime.signal)
                    .catch(() => undefined);
            }
        },
    });
    const announcedViews = new WeakSet<HTMLElement>();
    const loadSelectedSession = (target: SelectedConversationTarget): void => {
        const sessionId = target.kind === "conversation" ? target.conversationId : target.sessionId;
        // Capture this attempt's signal: navigation restarts the home load and
        // replaces chatLifetime with a fresh controller while this request is
        // still in flight. Both callbacks must validate the attempt they were
        // issued with, so a superseded read can never publish state — least of
        // all a failure — for the newer attempt that replaced it.
        const attempt = chatLifetime.signal;
        void requests
            .managedSession(botId, sessionId, attempt)
            .then((session) => {
                if (attempt.aborted) {
                    return;
                }
                const current = home.getState().selection;
                if (
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
                    // The re-attach read replaces the pane through the same
                    // entry as a ready transition inside home.load(): the
                    // previous pane may hold operation locks cancelled by its
                    // own stop(), and the freshly read session record must
                    // build the next model instead of the stopped one.
                    const ready = home.getState().selection;
                    if (ready.kind === "ready") {
                        replacePane(ready);
                    }
                }
            })
            .catch((cause: unknown) => {
                if (attempt.aborted) {
                    return;
                }
                const current = home.getState().selection;
                if (
                    current.kind === "loading" &&
                    current.target.kind !== "continue" &&
                    selectedConversationId(current) === sessionId
                ) {
                    // Surface the failure so the Reconnect control renders; its
                    // retry transitions to loading and announces a restart
                    // of the full home load.
                    home.setState((state) => ({
                        selection: transitionConversationSelection(state.selection, {
                            kind: "session-load-failed",
                            failure:
                                isRuntimeConnectionFailure(cause) || isChatBridgeError(cause)
                                    ? "connection"
                                    : "unavailable",
                            message: formatError(cause, "The Session could not be loaded."),
                            target: current.target,
                        }),
                    }));
                }
            });
    };
    // A loading selection at attach time means a previous view released it on
    // detach — the initial entry load is owned by home.load, so only a
    // re-attach re-reads the session itself. This gates the second read so a
    // fresh entry performs exactly one managedSession request.
    let releasedByDetach = false;
    // The single live pane model; replaced when a different session is
    // requested, torn down with the workspace.
    let paneEntry: ChatWorkspacePaneEntry | null = null;
    // Drafts belong to their sessions, independently of pane and connection replacements.
    const sessionAttachments = new Map<string, ReturnType<typeof createComposerAttachmentStore>>();
    // Submitted intent belongs to the Session until confirmed or discarded, across pane replacements.
    const sessionDeliveries = new Map<string, ReturnType<typeof createSessionDeliveryStore>>();
    const announceChatViewAttached = (node: HTMLElement): (() => void) => {
        if (announcedViews.has(node)) {
            return () => {};
        }
        announcedViews.add(node);
        const selection = home.getState().selection;
        if (releasedByDetach && selection.kind === "loading" && selection.target.kind !== "continue") {
            // The previous view released this selection when it detached; the
            // re-attached view re-reads the saved session so it does not render
            // the snapshot captured by the view instance that just went away.
            // Session targets take the same path as a fresh page load; a
            // conversation target re-reads the saved session record, which
            // omits the creation-time access envelope — the pane's live
            // reconciliation restores running-turn state from the service.
            releasedByDetach = false;
            loadSelectedSession(selection.target);
        }
        return () => {
            announcedViews.delete(node);
            // A chat view detaching releases its ready selection so the next
            // attached view re-reads the session instead of rendering the
            // snapshot captured by the view instance that just went away.
            const current = home.getState().selection;
            if (current.kind === "ready") {
                releasedByDetach = true;
                home.setState((state) => ({
                    selection: transitionConversationSelection(state.selection, { kind: "reload-requested" }),
                }));
            }
        };
    };

    const initialSelection = home.getState().selection;
    const initialSelectionId = selectedConversationId(initialSelection);
    statuses.getState().selectionChanged(initialSelectionId.length > 0 ? initialSelectionId : null);

    const replacePane = (selection: Extract<ConversationSelectionState, { readonly kind: "ready" }>): void => {
        if (paneEntry !== null && paneEntry.session === selection.session) {
            return;
        }
        // Keyed by the session record, not its id: every ready selection
        // arrives as a fresh record (a re-read for a reopened conversation, a
        // creation result for a new one), so the pane starts from a pristine
        // projection with its older-history pagination instead of whatever
        // the previous mount accumulated. The replaced pane's attached
        // element stops it through the ref-cleanup protocol.
        paneEntry?.model.stop();
        const sessionId = selection.session.result.ready.sessionId;
        if (options.rememberedIdentity !== undefined && rememberedSessionId !== sessionId) {
            rememberComputerVisit(
                options.rememberedIdentity,
                options.clock.now(),
                { kind: "session", sessionId },
                selection.session.result.ready.directoryLabel,
            );
            rememberedSessionId = sessionId;
        }
        const firstMessage = home.getState().firstMessages.get(sessionId);
        let composerAttachments = sessionAttachments.get(sessionId);
        if (composerAttachments === undefined) {
            composerAttachments = createComposerAttachmentStore();
            sessionAttachments.set(sessionId, composerAttachments);
        }
        let delivery = sessionDeliveries.get(sessionId);
        if (delivery === undefined) {
            delivery = createSessionDeliveryStore();
            sessionDeliveries.set(sessionId, delivery);
        }
        const model = createSessionPaneModel({
            clock: options.clock,
            session: selection.session,
            composerAttachments,
            delivery,
            attachmentSignal: operationsLifetime.signal,
            botId,
            requests,
            initialMessage: firstMessage,
            onInitialMessageDequeued: (commandId) => home.getState().initialMessageDequeued(sessionId, commandId),
            onStatusChange: (status) =>
                statuses.getState().statusChanged(botId, sessionId, status, statusLifetime.signal),
            onTitleChange: (id, title) => {
                home.getState().updateConversationTitle(id, title);
                directory.getState().titleObserved(id, title);
                sidebar.dialogs.getState().nativeDialog?.getState().titlesChanged();
            },
        });
        paneEntry = { model, session: selection.session };
    };

    return {
        computers: options.computers ?? null,
        accessNotice: options.accessNotice ?? null,
        recordUserActivity: () => {
            if (options.rememberedIdentity !== undefined) {
                const selection = home.getState().selection;
                const destination =
                    selection.kind === "ready"
                        ? { kind: "session" as const, sessionId: selection.session.result.ready.sessionId }
                        : selection.kind === "draft"
                          ? { kind: "home" as const }
                          : undefined;
                rememberComputerVisit(
                    options.rememberedIdentity,
                    options.clock.now(),
                    destination,
                    selection.kind === "ready" ? selection.session.result.ready.directoryLabel : undefined,
                );
            }
        },
        start: () => {
            void directory
                .getState()
                .followCalendar(operationsLifetime.signal)
                .catch((cause: unknown) => {
                    if (!operationsLifetime.signal.aborted) {
                        reportApplicationError(cause, "conversation-calendar");
                    }
                });
            void options.computers?.refresh();
            startHomeLoad();
            startDirectoryLoad();
        },
        requests,
        botId,
        bugReportDialog: options.bugReportDialog,
        projectId: options.projectId ?? null,
        directory,
        home,
        statuses,
        draftControls,
        sidebar,
        sessionPane: () => paneEntry?.model ?? null,
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
            options.computers?.dispose();
            home.getState().composerAttachments.getState().clear();
            for (const attachments of sessionAttachments.values()) {
                attachments.getState().clear();
            }
            sessionAttachments.clear();
            paneEntry?.model.stop();
            chatLifetime.abort(new Error("The chat workspace was disposed."));
            directoryLifetime.abort(new Error("The chat workspace was disposed."));
            statusLifetime.abort(new Error("Conversation status lifetime ended."));
            operationsLifetime.abort(new Error("The chat workspace was disposed."));
            sessionDeliveries.clear();
            statuses.getState().close();
        },
    };
}
