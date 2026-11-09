import { NativeSessionMap, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type {
    IdentityTransfer,
    LinkedDevice,
    OpenWindowsAfterDisconnect,
    SharingTerms,
} from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, type IdentityScope } from "../../services/identity/identity-scope-url.ts";
import { rememberComputerName, rememberComputerVisit } from "../../services/identity/remembered-computers.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { BugReportDialogStore } from "../bug-report-dialog-store.ts";
import { reportApplicationError } from "../report-error.ts";
import { type AccessExpiryStore, createAccessExpiryStore } from "./access-expiry-store.ts";
import { type BotChatHomeStoreApi, createBotChatHomeStore, homeWaitsForRuntime } from "./bot-chat-home-store.ts";
import type { ComputerSwitcherModel } from "./computer-switcher-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { type ConversationDirectoryStore, createConversationDirectoryStore } from "./conversation-directory-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import { selectedConversationTarget } from "./conversation-selection-machine.ts";
import { type ConversationStatusStoreApi, createConversationStatusStore } from "./conversation-status-store.ts";
import { createDeviceAccessStore, type DeviceAccessStore } from "./device-access-store.ts";
import { createDraftControlsStore, type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { createLinkedDevicesStore, type LinkedDevicesStore } from "./linked-devices-store.ts";
import { createNetworkDiagnosticStore, type NetworkDiagnosticStore } from "./network-diagnostic-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import { createRemoteAccessStore, type RemoteAccessStore } from "./remote-access-store.ts";
import { createRuntimeRecovery } from "./runtime-recovery.ts";
import { connectionWaitsForRuntime } from "./session-connection.ts";
import { createSessionPageState, type SessionPageState } from "./session-page-state.ts";
import { createSessionPaneModel, type SessionPaneModel } from "./session-pane-store.ts";
import { createSessionTitlesStore, type SessionTitlesStore } from "./session-titles-store.ts";
import { createSidebarDialogs, type SidebarDialogs } from "./sidebar-dialogs.ts";

interface ChatWorkspaceSidebar {
    readonly dialogs: SidebarDialogs;
    readonly remoteAccess: StoreApi<RemoteAccessStore>;
    readonly networkDiagnostic: StoreApi<NetworkDiagnosticStore>;
}

interface ChatWorkspacePaneEntry {
    readonly session: SelectedMortySession;
    readonly model: ReturnType<typeof createSessionPaneModel>;
}

export interface ChatWorkspace {
    readonly computers: ComputerSwitcherModel | null;
    readonly accessNotice: string | null;
    /** The page's one list of the other devices with access, and when this browser last looked at it. */
    readonly linkedDevices: StoreApi<LinkedDevicesStore> | null;
    /** When this browser's access ends; null when the page cannot read its own access. */
    readonly accessExpiry: StoreApi<AccessExpiryStore> | null;
    /** The devices with access to this computer and the disconnections made from them; null when this page cannot. */
    readonly deviceAccess: StoreApi<DeviceAccessStore> | null;
    /** The chat API this workspace was composed with. */
    readonly requests: BotChatApi;
    /** The application-owned bug-report dialog state, flowing to entry points. */
    readonly bugReportDialog: BugReportDialogStore;
    /** The Bot this workspace talks to; also scopes diagnostics sources. */
    readonly botId: string;
    /** The project location label source for the sidebar, when known. */
    readonly computerId: string | null;
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
                url.searchParams.delete("harness");
                url.searchParams.delete("sessionId");
            });
        },
        showManaged: (target: NativeSessionTarget) =>
            replace((url) => {
                url.searchParams.set("harness", target.harness);
                url.searchParams.set("sessionId", target.sessionId);
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
    /** Starts the page over once its Machine's revoked Runtime was replaced; see the home store's announcement. */
    readonly onRuntimeReplaced: () => void;
    readonly rememberedIdentity?: IdentityScope;
    readonly computers?: ComputerSwitcherModel;
    readonly accessNotice?: string | null;
    readonly entry?: "address" | "restore";
    readonly bugReportDialog: BugReportDialogStore;
    readonly computerId?: string;
    readonly requests: BotChatApi;
    readonly url?: string;
    readonly createTransfer?: ((terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>) | undefined;
    readonly currentAccessToken?: ((signal: AbortSignal) => Promise<string>) | undefined;
    readonly endRemoteAccess?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly accessExpiresAt?: ((signal: AbortSignal) => Promise<string | null>) | undefined;
    readonly linkedDevices?: ((signal: AbortSignal) => Promise<readonly LinkedDevice[]>) | undefined;
    readonly waitForLinkedDevicesChange?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly endOtherBrowserAccess?: ((signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>) | undefined;
    readonly endDeviceAccess?:
        | ((deviceId: string, signal: AbortSignal) => Promise<OpenWindowsAfterDisconnect>)
        | undefined;
    readonly networkDiagnostics?: {
        readonly measureBrowserRelay: (origin: string, signal: AbortSignal) => Promise<number>;
        readonly measureBrowserMorty: (signal: AbortSignal) => Promise<number>;
    };
}): ChatWorkspace {
    const botId = options.botId;
    const requests = options.requests;
    let rememberedSessionTarget: NativeSessionTarget | null = null;
    let initialVisitPending = true;
    const recordHome = () => {
        rememberedSessionTarget = null;
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
        onRuntimeReplaced: () => {
            // A Session belongs to the Runtime that held it, so the page starts over on the Machine's new conversation.
            const url = new URL(window.location.href);
            url.searchParams.delete("harness");
            url.searchParams.delete("sessionId");
            window.history.replaceState(window.history.state, "", url);
            options.onRuntimeReplaced();
        },
        onDirectoryRefreshed: () => startDirectoryLoad(),
        onFirstMessage: (sessionTarget, message) =>
            sessionState(sessionTarget).delivery.getState().awaitConnection(message),
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
        (sessionTarget) => {
            // Closing changes directory membership. Replace any read started before that change in the same
            // lifecycle that owns refreshes, so its delayed answer cannot put the closed Session back.
            startDirectoryLoad();
            const selected = selectedConversationTarget(home.getState().selection);
            if (selected === null || !sameNativeSession(selected, sessionTarget)) {
                return;
            }
            home.getState().newConversation();
        },
    );
    const statuses = createConversationStatusStore(
        requests,
        () => {
            const selected = selectedConversationTarget(home.getState().selection);
            return selected;
        },
        (sessionTarget, reason) => {
            // Only the open pane has something to tell its user; the other Sessions reopen when selected.
            if (paneEntry !== null && sameNativeSession(paneEntry.session.result.ready.target, sessionTarget)) {
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
            signal: () => operationsLifetime.signal,
            botId,
            requests,
            runtime: () => home.getState().runtimeConfiguration?.runtime ?? null,
            createTransfer: (terms, signal) => {
                if (options.createTransfer === undefined) {
                    return Promise.reject(new Error("Identity sharing is unavailable."));
                }
                return options.createTransfer(terms, signal);
            },
            onOpenSession: (session) => {
                home.getState().openManaged({
                    harness: session.result.ready.agentId,
                    sessionId: session.entry.sessionId,
                });
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
            measureBrowserRelay: (origin, signal) => {
                if (options.networkDiagnostics === undefined) {
                    return Promise.reject(new Error("Network diagnostics are unavailable."));
                }
                return options.networkDiagnostics.measureBrowserRelay(origin, signal);
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
    // What the page holds for each Session, independently of pane and connection replacements.
    const sessionStates = new NativeSessionMap<SessionPageState>();
    const sessionState = (sessionTarget: NativeSessionTarget): SessionPageState => {
        const existing = sessionStates.get(sessionTarget);
        if (existing !== undefined) {
            return existing;
        }
        const state = createSessionPageState({
            botId,
            sessionTarget,
            clock: options.clock,
            lifetime: operationsLifetime.signal,
        });
        sessionStates.set(sessionTarget, state);
        return state;
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
        const sessionTarget = selection.session.result.ready.target;
        if (
            options.rememberedIdentity !== undefined &&
            (rememberedSessionTarget === null || !sameNativeSession(rememberedSessionTarget, sessionTarget))
        ) {
            rememberComputerVisit(
                options.rememberedIdentity,
                options.clock.now(),
                {
                    kind: "session",
                    harness: selection.session.result.ready.agentId,
                    sessionId: selection.session.entry.sessionId,
                },
                selection.session.result.ready.directoryLabel,
            );
            rememberedSessionTarget = sessionTarget;
        }
        const sessionPage = sessionState(sessionTarget);
        // Only the draft page that followed its first message here hands over the draft written meanwhile.
        const handoff = home.getState().takeNextDraft(sessionTarget);
        if (handoff !== null) {
            sessionPage.composer.getState().adoptHandoff(handoff.draft, handoff.attachments);
        }
        const model = createSessionPaneModel({
            clock: options.clock,
            session: selection.session,
            sessionPage,
            attachmentSignal: operationsLifetime.signal,
            botId,
            requests,
            onReleased: (activity) => statuses.getState().paneReleased(sessionTarget, activity),
            titles,
            connectionAvailable: (connection) => connectionPresentation(home.getState(), connection).available,
            onConnected: () => runtimeRecovery.working(),
            onWaitingForRuntime: () => runtimeRecovery.failed(),
        });
        paneEntry = { model, session: selection.session };
        model.start();
    };

    const linkedDevices =
        options.computerId === undefined ||
        options.linkedDevices === undefined ||
        options.waitForLinkedDevicesChange === undefined
            ? null
            : createLinkedDevicesStore({
                  computerId: options.computerId,
                  linkedDevices: options.linkedDevices,
                  waitForChange: options.waitForLinkedDevicesChange,
                  waitForBridge: requests.waitForBridge,
              });
    const endOtherBrowserAccess = options.endOtherBrowserAccess;
    const endDeviceAccess = options.endDeviceAccess;
    const accessExpiry =
        options.computerId === undefined || options.accessExpiresAt === undefined
            ? null
            : createAccessExpiryStore({
                  computerId: options.computerId,
                  accessExpiresAt: options.accessExpiresAt,
                  clock: options.clock,
              });
    return {
        computers: options.computers ?? null,
        accessNotice: options.accessNotice ?? null,
        linkedDevices,
        accessExpiry,
        deviceAccess:
            endOtherBrowserAccess === undefined || endDeviceAccess === undefined || linkedDevices === null
                ? null
                : createDeviceAccessStore({
                      endDeviceAccess,
                      endOtherBrowserAccess,
                      readDevices: linkedDevices.getState().refresh,
                  }),
        recordUserActivity: () => {
            if (options.rememberedIdentity !== undefined) {
                const selection = home.getState().selection;
                const destination =
                    selection.kind === "ready"
                        ? {
                              kind: "session" as const,
                              harness: selection.session.result.ready.agentId,
                              sessionId: selection.session.entry.sessionId,
                          }
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
        computerId: options.computerId ?? null,
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
            for (const state of sessionStates.values()) {
                state.composer.getState().attachments.getState().clear();
            }
            paneEntry?.model.stop();
            chatLifetime.abort(new Error("The chat workspace was disposed."));
            directoryLifetime.abort(new Error("The chat workspace was disposed."));
            statusLifetime.abort(new Error("Conversation status lifetime ended."));
            operationsLifetime.abort(new Error("The chat workspace was disposed."));
            sessionStates.clear();
            statuses.getState().close();
        },
    };
}
