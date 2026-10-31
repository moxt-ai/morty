import type { StoreApi } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer } from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, type IdentityScope } from "../../services/identity/identity-scope-url.ts";
import { rememberComputerName, rememberComputerVisit } from "../../services/identity/remembered-computers.ts";
import {
    centralSessionStorage,
    SessionStorageWriteError,
    sessionPendingSubmissionEntry,
    sessionUnsentMessageEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { BugReportDialogStore } from "../bug-report-dialog-store.ts";
import { reportApplicationError } from "../report-error.ts";
import { type BotChatHomeStoreApi, createBotChatHomeStore, homeWaitsForRuntime } from "./bot-chat-home-store.ts";
import { createComposerAttachmentStore } from "./composer-attachment-store.ts";
import type { ComputerSwitcherModel } from "./computer-switcher-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { type ConversationDirectoryStore, createConversationDirectoryStore } from "./conversation-directory-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import { selectedConversationId } from "./conversation-selection-machine.ts";
import { type ConversationStatusStoreApi, createConversationStatusStore } from "./conversation-status-store.ts";
import { createDraftControlsStore, type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { createNetworkDiagnosticStore, type NetworkDiagnosticStore } from "./network-diagnostic-store.ts";
import type { SelectedMobiusSession } from "./open-session.ts";
import { createRemoteAccessStore, type RemoteAccessStore } from "./remote-access-store.ts";
import { createRuntimeRecovery } from "./runtime-recovery.ts";
import { connectionWaitsForRuntime } from "./session-connection.ts";
import { createSessionDeliveryStore, prependToDraft } from "./session-delivery-store.ts";
import { createSessionMessageQueueStore } from "./session-message-queue-store.ts";
import { createSessionPaneModel, type SessionPaneModel } from "./session-pane-store.ts";
import { createSessionTitlesStore, type SessionTitlesStore } from "./session-titles-store.ts";
import { createSidebarDialogs, type SidebarDialogs } from "./sidebar-dialogs.ts";

interface ChatWorkspaceSidebar {
    readonly dialogs: SidebarDialogs;
    readonly remoteAccess: StoreApi<RemoteAccessStore>;
    readonly networkDiagnostic: StoreApi<NetworkDiagnosticStore>;
}

interface ChatWorkspacePaneEntry {
    readonly session: SelectedMobiusSession;
    readonly model: ReturnType<typeof createSessionPaneModel>;
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
    readonly titles: SessionTitlesStore;
    readonly directory: StoreApi<ConversationDirectoryStore>;
    readonly statuses: ConversationStatusStoreApi;
    /** Harness and working-directory settings for the next draft message. */
    readonly draftControls: StoreApi<DraftControlsStore>;
    /** Sidebar ephemeral UI and dialog stores; lives outside React with this workspace. */
    readonly sidebar: ChatWorkspaceSidebar;
    /**
     * The session pane model for the currently selected conversation, created
     * and started by the workspace when the selection becomes ready for a
     * fresh session record and stopped when it moves on. Render-time access is
     * a pure read: `null` means the pane for the ready selection is not built
     * (yet), which no current view renders through.
     */
    readonly sessionPane: () => SessionPaneModel | null;
    /** Restarts the draft settings load, for example from its retry control. */
    readonly retryDraftControls: () => void;
    /** Restarts the directory load, for example from the sidebar refresh button. */
    readonly refreshDirectory: () => void;
    /** Reports a session activity change from an open session pane. */
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
        showDraft: () => {
            onDraft();
            replace((url) => {
                url.searchParams.delete("sessionId");
            });
        },
        showManaged: (id: string) =>
            replace((url) => {
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
    const titles: SessionTitlesStore = createSessionTitlesStore(
        options.rememberedIdentity === undefined ? null : encodeIdentityScope(options.rememberedIdentity),
    );
    const home: BotChatHomeStoreApi = createBotChatHomeStore(requests, {
        botId,
        titles,
        draftConfiguration: () => draftConfiguration(draftControls.getState().settings),
        connectionAvailable: () => connectionPresentation(home.getState(), null).available,
        clock: options.clock,
        onWaitingForRuntime: () => runtimeRecovery.failed(),
        createId: () => crypto.randomUUID(),
        navigation: historyNavigation(recordHome),
        entry: options.entry ?? "address",
        onRuntimeConfiguration: (configuration, observation) => {
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
        onFirstMessage: (sessionId, message) => sessionDelivery(sessionId).getState().awaitConnection(message),
        onSelectionReady: (selection) => {
            runtimeRecovery.working();
            replacePane(selection);
        },
        onSelectionTargeted: (conversationId) => {
            if (conversationId !== null) {
                statuses.getState().opened(conversationId);
            }
            // A pane lives while its session record is the ready selection; any other target ends it.
            const selection = home.getState().selection;
            if (paneEntry !== null && (selection.kind !== "ready" || selection.session !== paneEntry.session)) {
                paneEntry.model.stop();
                paneEntry = null;
            }
        },
        url: options.url ?? window.location.href,
    });
    const directory = createConversationDirectoryStore(
        botId,
        requests,
        (sessions) => {
            statuses.getState().directoryLoaded(botId, sessions, statusLifetime.signal);
        },
        options.clock,
        titles,
        (sessionId) => {
            if (selectedConversationId(home.getState().selection) !== sessionId) {
                return;
            }
            home.getState().newConversation();
        },
    );
    const statuses = createConversationStatusStore(
        requests,
        () => {
            const selected = selectedConversationId(home.getState().selection);
            return selected.length > 0 ? selected : null;
        },
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
            createTransfer: (signal) => {
                if (options.createTransfer === undefined) {
                    return Promise.reject(new Error("Identity sharing is unavailable."));
                }
                return options.createTransfer(signal);
            },
            onOpenSession: (session) => {
                home.getState().openManaged(session.result.ready.sessionId);
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
    /** The live pane, when its connection used up its automatic retries and waits for the Runtime. */
    const paneWaitingForRuntime = (): ChatWorkspacePaneEntry | null =>
        paneEntry !== null && connectionWaitsForRuntime(paneEntry.model.store.getState().connection) ? paneEntry : null;
    /**
     * Retries everything the page reads through the Runtime that it could not read while the Runtime was unreachable:
     * the home view, the session list, the stream that follows their statuses, and the open Session's connection.
     * Each retries only what it lost. Restarting the home view reloads the list with it, and a list load follows the
     * statuses again.
     */
    const runtimeRecovery = createRuntimeRecovery({
        clock: options.clock,
        lifetime: operationsLifetime.signal,
        waiting: () =>
            homeWaitsForRuntime(home.getState()) ||
            listWaitsForRuntime() ||
            statuses.getState().unfollowed() ||
            draftWaitsForRuntime() ||
            paneWaitingForRuntime() !== null,
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
            paneWaitingForRuntime()?.model.reconnect();
        },
    });
    // The single live pane model. It lives while its session record is the
    // ready selection: another target stops it, a re-read replaces it, and
    // the workspace tears it down.
    let paneEntry: ChatWorkspacePaneEntry | null = null;
    // Drafts belong to their sessions, independently of pane and connection replacements.
    const sessionAttachments = new Map<string, ReturnType<typeof createComposerAttachmentStore>>();
    // Submitted intent belongs to the Session until confirmed or discarded, across pane replacements.
    const sessionDeliveries = new Map<string, ReturnType<typeof createSessionDeliveryStore>>();
    const sessionQueues = new Map<string, ReturnType<typeof createSessionMessageQueueStore>>();
    /** The Session's delivery on this page, which persists what it holds for the next page to recover. */
    const sessionDelivery = (sessionId: string): ReturnType<typeof createSessionDeliveryStore> => {
        const existing = sessionDeliveries.get(sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const unsentEntry = sessionUnsentMessageEntry(sessionId);
        const pendingEntry = sessionPendingSubmissionEntry(botId, sessionId);
        const delivery = createSessionDeliveryStore({
            pendingSubmission: centralSessionStorage.read(pendingEntry),
            pendingSubmissionChanged: (journal) => {
                if (journal === null) {
                    centralSessionStorage.remove(pendingEntry);
                } else if (!centralSessionStorage.write(pendingEntry, journal)) {
                    throw new SessionStorageWriteError();
                }
            },
            unsentMessageChanged: (content) => {
                if (content === null) {
                    centralSessionStorage.remove(unsentEntry);
                } else {
                    centralSessionStorage.write(unsentEntry, content);
                }
            },
        });
        sessionDeliveries.set(sessionId, delivery);
        return delivery;
    };
    const replacePane = (selection: Extract<ConversationSelectionState, { readonly kind: "ready" }>): void => {
        if (paneEntry !== null && paneEntry.session === selection.session) {
            return;
        }
        // Keyed by the session record, not its id: every ready selection
        // arrives as a fresh record (a re-read for a reopened conversation, a
        // creation result for a new one), so the pane starts from a pristine
        // projection with its older-history pagination instead of whatever
        // the previous pane accumulated.
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
        let composerAttachments = sessionAttachments.get(sessionId);
        let nextDraft: string | null = null;
        if (composerAttachments === undefined) {
            // Only the draft page that followed its first message here hands over the draft written meanwhile.
            const handoff = home.getState().takeNextDraft(sessionId);
            composerAttachments = handoff?.attachments ?? createComposerAttachmentStore();
            nextDraft = handoff?.draft ?? null;
            sessionAttachments.set(sessionId, composerAttachments);
        }
        let unsent: string | null = null;
        if (!sessionDeliveries.has(sessionId)) {
            // A message an earlier page left unsent returns to the composer; it is never delivered implicitly.
            const unsentEntry = sessionUnsentMessageEntry(sessionId);
            unsent = centralSessionStorage.read(unsentEntry);
            centralSessionStorage.remove(unsentEntry);
        }
        const delivery = sessionDelivery(sessionId);
        let messageQueue = sessionQueues.get(sessionId);
        if (messageQueue === undefined) {
            messageQueue = createSessionMessageQueueStore();
            sessionQueues.set(sessionId, messageQueue);
        }
        const model = createSessionPaneModel({
            clock: options.clock,
            session: selection.session,
            composerAttachments,
            delivery,
            messageQueue,
            attachmentSignal: operationsLifetime.signal,
            botId,
            requests,
            onReleased: (activity) => statuses.getState().paneReleased(sessionId, activity),
            titles,
            connectionAvailable: (connection) => connectionPresentation(home.getState(), connection).available,
            onConnected: () => runtimeRecovery.working(),
            onWaitingForRuntime: () => runtimeRecovery.failed(),
        });
        if (nextDraft !== null || unsent !== null) {
            const draft = nextDraft ?? model.store.getState().draft;
            model.store.getState().setDraft(unsent === null ? draft : prependToDraft(unsent, draft));
        }
        paneEntry = { model, session: selection.session };
        model.start();
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
        titles,
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
        refreshDirectory: startDirectoryLoad,
        chatSignal: () => chatLifetime.signal,
        operationsSignal: () => operationsLifetime.signal,
        dispose: () => {
            options.computers?.dispose();
            sidebar.dialogs.getState().discardNativeDialog();
            sidebar.dialogs.getState().closeSharing();
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
            sessionQueues.clear();
            statuses.getState().close();
        },
    };
}
