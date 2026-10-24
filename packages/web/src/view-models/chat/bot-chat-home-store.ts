import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
import { createComposerAttachmentStore } from "../../components/chat/composer-attachment-store.ts";
import { isChatBridgeError } from "../../services/api/websocket-api-transport.ts";
import type {
    BotChatApi,
    BotRuntimeConfiguration,
    ChatAccess,
    ChatDraftConfiguration,
} from "../../services/chat/bot-chat-api.ts";
import { CloudApiError, isRuntimeConnectionFailure } from "../../services/management/management-api.ts";
import {
    centralSessionStorage,
    newConversationDraftEntry,
} from "../../services/session-storage/central-session-storage.ts";
import { formatError } from "../format-error.ts";
import {
    type ConversationCreationState,
    type FirstMessages,
    transitionConversationCreation,
    transitionFirstMessages,
} from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionState,
    type ConversationTarget,
    selectedConversationId,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import type { RuntimeObservation } from "./runtime-recovery.ts";
import type { UnconfirmedSubmission } from "./session-delivery-store.ts";

export type BotChatHomeStoreApi = ReturnType<typeof createBotChatHomeStore>;

export type SetupReason = "unconfigured" | "agent-missing" | "runtime-offline" | "agent-required";

/**
 * A page serves exactly one Bot: the one provisioned with the active
 * identity. Views carry its identifier; the Bot has no user-facing name.
 */
type BotView = { readonly botId: string };
type BotChatHomeView =
    | { readonly kind: "loading" }
    | ({ readonly kind: "connecting" } & BotView)
    | ({ readonly kind: "active" } & BotView)
    | ({ readonly kind: "setup"; readonly reason: SetupReason } & BotView)
    | ({ readonly kind: "runtime-disconnected"; readonly message: string } & BotView)
    | { readonly kind: "failed"; readonly message: string };

export type BotConnectionStatus =
    | { readonly kind: "connecting"; readonly label: "Connecting" }
    | { readonly kind: "connected"; readonly label: "Connected" }
    | { readonly kind: "unavailable"; readonly label: "Unavailable" }
    | { readonly kind: "unpaired"; readonly label: "Disconnected" }
    | { readonly kind: "disconnected"; readonly label: "Disconnected" };

/**
 * The Machine's connection as the page shows it everywhere. It is derived from the Runtime configuration the page
 * follows, so no failure path can leave one part of the page saying offline while another says online.
 */
export function botConnectionStatus(
    home: Pick<BotChatHomeStore, "runtimeConfiguration" | "view" | "configurationWatch" | "networkAvailable">,
): BotConnectionStatus {
    if (home.view.kind === "setup" && home.view.reason === "unconfigured") {
        return { kind: "unpaired", label: "Disconnected" };
    }
    if (!home.networkAvailable || home.configurationWatch.kind === "unavailable") {
        return { kind: "unavailable", label: "Unavailable" };
    }
    if (home.runtimeConfiguration !== null) {
        return home.runtimeConfiguration.runtime.online
            ? { kind: "connected", label: "Connected" }
            : { kind: "disconnected", label: "Disconnected" };
    }
    switch (home.view.kind) {
        case "loading":
        case "connecting":
        case "active":
            return { kind: "connecting", label: "Connecting" };
        case "setup":
        case "runtime-disconnected":
        case "failed":
            return { kind: "disconnected", label: "Disconnected" };
    }
}

/**
 * Whether the home view failed only because the Runtime was unreachable, so the workspace retries it once the Runtime
 * is back. Only loads that read are: continuing a native session forks or imports it, and a connection that dropped
 * mid-request cannot show it did not happen, so the user decides whether to retry.
 */
export function homeWaitsForRuntime(home: Pick<BotChatHomeStore, "view" | "selection">): boolean {
    return home.view.kind === "runtime-disconnected" && retriesAutomatically(home.selection);
}

function retriesAutomatically(selection: ConversationSelectionState): boolean {
    switch (selection.kind) {
        case "draft":
            return false;
        case "loading":
        case "failed":
        case "ready":
            return selection.target.kind !== "continue";
    }
}

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (isExternal: boolean, id: string) => void;
    readonly showContinuedSession: (sessionId: string) => void;
    readonly showForkInstead: () => void;
}

/**
 * One-shot entry notices. The workflow marks a notice `visible` exactly once
 * when it resolves; dismissal hides it for the rest of the entry.
 */
type ChatEntryNotice = { readonly kind: "hidden" } | { readonly kind: "visible" };

interface ChatEntryNotices {
    readonly pairing: ChatEntryNotice;
}

export interface BotChatHomeStore {
    readonly composerAttachments: ReturnType<typeof createComposerAttachmentStore>;
    readonly view: BotChatHomeView;
    readonly runtimeConfiguration: BotRuntimeConfiguration | null;
    readonly configurationWatch:
        | { readonly kind: "checking" }
        | { readonly kind: "current"; readonly checkedAt: number }
        | { readonly kind: "unavailable"; readonly lastCheckedAt: number | null };
    readonly networkAvailable: boolean;
    readonly setNetworkAvailable: (available: boolean) => void;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    /** First messages of created conversations that the service has not accepted yet, whichever is on screen. */
    readonly firstMessages: FirstMessages;
    readonly revision: number;
    readonly directoryRevision: number;
    readonly draft: string;
    /** The draft the composer text belongs to. Only starting a new draft changes it. */
    readonly draftKey: string;
    readonly draftSettings: ChatDraftConfiguration | null;
    /** Bumped whenever the message list should re-arm following the latest message. */
    readonly scrollFollowRevision: number;
    /** The pairing dialog the user opened manually from the sidebar. */
    readonly pairingDialogOpen: boolean;
    /** Entry notices that surface a dialog once when the workflow resolves. */
    readonly notices: ChatEntryNotices;
    readonly dismissNotice: () => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly newConversation: () => void;
    readonly openManaged: (isExternal: boolean, id: string) => void;
    readonly retry: () => void;
    readonly forkInstead: () => void;
    readonly setDraft: (draft: string) => void;
    readonly setDraftSettings: (settings: ChatDraftConfiguration | null) => void;
    readonly showPairingDialog: () => void;
    readonly closePairingDialog: () => void;
    readonly updateConversationTitle: (sessionId: string, title: string) => void;
    /** Clears the queued first message once the pane has sent it. */
    readonly initialMessageDelivered: (conversationId: string) => void;
    /** Drops the recovery copy after the user removed the uncertain first message. */
    readonly initialMessageRecoveryCleared: (conversationId: string, commandId: string) => void;
    /** Marks the queued first message unconfirmed after an uncertain submission. */
    readonly initialMessageUnconfirmed: (conversationId: string, journal: UnconfirmedSubmission) => void;
    readonly createConversation: (signal: AbortSignal) => Promise<boolean>;
}

function initialSelection(urlValue: string, createId: () => string): ConversationSelectionState {
    const url = new URL(urlValue);
    const sessionId = url.searchParams.get("sessionId");
    const harness = url.searchParams.get("harness");
    const requestedAction = url.searchParams.get("nativeSessionAction");
    if (sessionId !== null && isIdentifier(sessionId)) {
        if (harness !== null && isIdentifier(harness)) {
            return requestedAction === null || requestedAction === "fork" || requestedAction === "import"
                ? {
                      kind: "loading",
                      target: { kind: "continue", action: requestedAction ?? "fork", harness, sessionId },
                  }
                : { kind: "draft", key: createId() };
        }
        return { kind: "loading", target: { kind: "session", sessionId } };
    }
    const conversationId = url.searchParams.get("conversationId");
    return conversationId !== null && isIdentifier(conversationId)
        ? { kind: "loading", target: { kind: "conversation", conversationId } }
        : { kind: "draft", key: createId() };
}

function setupReason(configuration: BotRuntimeConfiguration): SetupReason | null {
    if (configuration.runtime.agents.length === 0) {
        return "agent-missing";
    }
    return configuration.runtime.online ? null : "runtime-offline";
}

export const createBotChatHomeStore = (
    requests: Pick<
        BotChatApi,
        | "access"
        | "conversationSession"
        | "continueNativeSession"
        | "createConversation"
        | "managedSession"
        | "readBot"
        | "waitForSetupChange"
        | "waitForRuntimeConfigurationChange"
        | "runtimeConfiguration"
        | "directory"
        | "waitForBridge"
    >,
    options: {
        readonly botId: string;
        readonly entry?: "address" | "restore";
        /**
         * Announced with every Runtime configuration the page observes, after the view follows it: the owner keeps the
         * other workspace workflows on it and retries what the Runtime failed once it is back.
         */
        readonly onRuntimeConfiguration: (
            configuration: BotRuntimeConfiguration,
            observation: RuntimeObservation,
        ) => void;
        readonly onRuntimeConfigurationUnavailable: () => void;
        /** Announced when the view failed only because the Runtime was unreachable and waits for it to be retried. */
        readonly onWaitingForRuntime: () => void;
        readonly now: () => number;
        readonly url: string;
        readonly createId: () => string;
        readonly navigation: BotChatNavigation;
        /** Announced after a transition that bumps the load revision: the owner restarts the home and directory loads. */
        readonly onRestart: () => void;
        /** Announced when only the directory revision advances (a created conversation joins it) without reloading the home view. */
        readonly onDirectoryRefreshed: () => void;
        /** Announced with the first-prompt title of a conversation this page created, before the directory lists it. */
        readonly onConversationCreated: (conversationId: string, title: string) => void;
        /** Announced after a transition that selects a new draft: the owner reloads the draft controls. */
        readonly onDraftSelected: () => void;
        /** Announced after a transition that targets another conversation: the owner re-scopes the status watch. */
        readonly onSelectionTargeted: (conversationId: string | null) => void;
        /** Announced after a transition that makes a selection ready: the owner builds the pane for it. */
        readonly onSelectionReady: (selection: Extract<ConversationSelectionState, { readonly kind: "ready" }>) => void;
    },
) => {
    const botId = options.botId;
    const composerAttachments = createComposerAttachmentStore();
    const conversations = createConversationSessionStore(requests);
    const selection = initialSelection(options.url, options.createId);
    let restoredSessionId =
        options.entry === "restore" && selection.kind === "loading" && selection.target.kind === "session"
            ? selection.target.sessionId
            : null;
    const {
        onRestart,
        onDirectoryRefreshed,
        onConversationCreated,
        onDraftSelected,
        onSelectionTargeted,
        onSelectionReady,
    } = options;
    return createStore<BotChatHomeStore>()((set, get) => {
        // Announced from the explicit transition sites: a ready selection
        // builds the pane for it, and every selection transition re-scopes
        // the status watch to the selected conversation (null for a draft).
        const announceSelection = (): void => {
            const selection = get().selection;
            onSelectionTargeted(
                selectedConversationId(selection).length > 0 ? selectedConversationId(selection) : null,
            );
            if (selection.kind === "ready") {
                onSelectionReady(selection);
            }
        };
        const configurationUnavailable = (): void => {
            const watch = get().configurationWatch;
            set({
                configurationWatch: {
                    kind: "unavailable",
                    lastCheckedAt:
                        watch.kind === "current"
                            ? watch.checkedAt
                            : watch.kind === "unavailable"
                              ? watch.lastCheckedAt
                              : null,
                },
            });
            options.onRuntimeConfigurationUnavailable();
        };
        return {
            composerAttachments,
            view: { kind: "loading" },
            runtimeConfiguration: null,
            configurationWatch: { kind: "checking" },
            networkAvailable: navigator.onLine,
            setNetworkAvailable: (available) => {
                set({ networkAvailable: available });
            },
            selection,
            creation: { kind: "draft" },
            firstMessages: new Map(),
            revision: 0,
            directoryRevision: 0,
            draft: "",
            draftKey: selection.kind === "draft" ? selection.key : options.createId(),
            draftSettings: null,
            scrollFollowRevision: 0,
            pairingDialogOpen: false,
            notices: { pairing: { kind: "hidden" } },
            dismissNotice: () => set((current) => ({ notices: { ...current.notices, pairing: { kind: "hidden" } } })),
            load: async (signal) => {
                set((current) => ({ view: "botId" in current.view ? current.view : { kind: "loading" } }));
                /**
                 * Which stage of the load is in flight. A bridge failure before
                 * the session content exists is an unfinished user request that
                 * must become an operable failure; afterwards it only takes the
                 * background watches, which can be resumed without replaying
                 * the session load.
                 */
                let phase: "request" | "setup" | "watch" = "request";
                const completeSetup = (): void => {
                    signal.throwIfAborted();
                    get().retry();
                };
                /**
                 * Follows the Runtime configuration. Each watch adopts its comparison baseline as the snapshot, so a
                 * brief Runtime change between two reads cannot leave the page stale. `baselineFollowsChange` says
                 * the first baseline may already differ from what the page last saw, as after a dropped bridge.
                 */
                const watchRuntimeConfigurationChanges = async (baselineFollowsChange = false): Promise<void> => {
                    let afterChange = baselineFollowsChange;
                    while (true) {
                        try {
                            await requests.waitForRuntimeConfigurationChange(botId, signal, (configuration) =>
                                applyConfiguration(configuration, afterChange),
                            );
                        } catch (cause) {
                            if (cause instanceof DOMException && cause.name === "TimeoutError") {
                                continue;
                            }
                            throw cause;
                        }
                        signal.throwIfAborted();
                        afterChange = true;
                    }
                };
                /**
                 * Adopts a watched Runtime configuration snapshot: a draft's view follows it, and the workspace
                 * retries what the Runtime failed once a snapshot shows it back.
                 */
                const applyConfiguration = (configuration: BotRuntimeConfiguration, afterChange: boolean): void => {
                    signal.throwIfAborted();
                    const reason = setupReason(configuration);
                    observeConfiguration(
                        configuration,
                        { kind: "watch", afterChange },
                        get().selection.kind === "draft"
                            ? { view: reason === null ? { kind: "active", botId } : { kind: "setup", botId, reason } }
                            : {},
                    );
                };
                /**
                 * Records a Runtime configuration the page observed, from a watch or a direct read, with whatever the
                 * caller derives from it in the same update, and announces it to the other workspace workflows.
                 */
                const observeConfiguration = (
                    configuration: BotRuntimeConfiguration,
                    observation: RuntimeObservation,
                    derived: Pick<Partial<BotChatHomeStore>, "view"> = {},
                ): void => {
                    set({
                        ...derived,
                        runtimeConfiguration: configuration,
                        configurationWatch: { kind: "current", checkedAt: options.now() },
                    });
                    options.onRuntimeConfiguration(configuration, observation);
                };
                /**
                 * A dropped socket takes every watch with it. This loop re-arms
                 * the safe watches every time the bridge returns, so repeated
                 * drops on the same page keep being followed by recovery, and a
                 * drop during the recovery reads themselves re-enters it. The
                 * recovery only re-reads pairing and restores configuration watches:
                 * it never re-issues a fork/import load that the user did not ask to
                 * repeat.
                 */
                const followConfigurationChanges = async (watchSignal: AbortSignal): Promise<void> => {
                    let dropped = true;
                    let armed = false;
                    while (true) {
                        try {
                            if (dropped) {
                                await requests.waitForBridge(watchSignal);
                                watchSignal.throwIfAborted();
                                const detail = await requests.readBot(botId, watchSignal);
                                watchSignal.throwIfAborted();
                                if (!detail.configured) {
                                    // The setup watch only exists for an
                                    // unconfigured Machine; the pairing flow
                                    // completes by restarting the load.
                                    await requests.waitForSetupChange(botId, watchSignal);
                                    watchSignal.throwIfAborted();
                                    completeSetup();
                                    return;
                                }
                                if (phase === "setup") {
                                    // Pairing completed during the outage. Finish
                                    // setup just as a setup-watch notification
                                    // would, including draft settings and the
                                    // directory. No session operation was issued
                                    // while the Machine was unconfigured.
                                    completeSetup();
                                    return;
                                }
                                dropped = false;
                            }
                            // A configured Machine keeps following workspace
                            // changes even while its Runtime is offline: the
                            // setup endpoint answers it a fixed
                            // BOT_RUNTIME_FIXED fingerprint that never fires.
                            // A watch re-armed after a dropped bridge may find a Runtime that changed meanwhile.
                            const rearmed = armed;
                            armed = true;
                            await watchRuntimeConfigurationChanges(rearmed);
                            return;
                        } catch (cause) {
                            watchSignal.throwIfAborted();
                            if (!isChatBridgeError(cause)) {
                                throw cause;
                            }
                            console.error("The Chat WebSocket bridge failed to complete a request.", cause);
                            configurationUnavailable();
                            dropped = true;
                        }
                    }
                };
                try {
                    const current = get();
                    if (
                        current.view.kind === "active" &&
                        current.selection.kind === "loading" &&
                        current.selection.target.kind === "session"
                    ) {
                        const target = current.selection.target;
                        const session = await requests.managedSession(botId, target.sessionId, signal);
                        signal.throwIfAborted();
                        set((state) => ({
                            selection: transitionConversationSelection(state.selection, {
                                kind: "session-loaded",
                                session,
                                target,
                            }),
                        }));
                        announceSelection();
                        phase = "watch";
                        await followConfigurationChanges(signal);
                        return;
                    }
                    set((current) =>
                        current.view.kind === "loading"
                            ? {
                                  view: { kind: "connecting", botId },
                                  ...(current.selection.kind === "draft"
                                      ? { draft: centralSessionStorage.read(newConversationDraftEntry(botId)) ?? "" }
                                      : {}),
                              }
                            : current,
                    );
                    const detail = await requests.readBot(botId, signal);
                    signal.throwIfAborted();
                    if (!detail.configured) {
                        set((current) => ({
                            selection:
                                current.selection.kind === "loading"
                                    ? transitionConversationSelection(current.selection, {
                                          kind: "session-load-failed",
                                          message: "Connect your local agent to load this session.",
                                          target: current.selection.target,
                                      })
                                    : current.selection,
                            view: { kind: "setup", botId, reason: "unconfigured" },
                            ...(current.notices.pairing.kind === "hidden"
                                ? { notices: { ...current.notices, pairing: { kind: "visible" as const } } }
                                : {}),
                        }));
                        // The bridge drop during the setup wait is handled by
                        // the same repeatable recovery loop that owns every
                        // later watch: it waits for the bridge, re-reads the
                        // pairing state, and keeps waiting on the setup watch
                        // for an unconfigured Machine.
                        phase = "setup";
                        await followConfigurationChanges(signal);
                        return;
                    }
                    const configuration = await requests.runtimeConfiguration(botId, signal);
                    signal.throwIfAborted();
                    observeConfiguration(configuration, { kind: "read" });
                    const currentSelection = get().selection;
                    const currentTarget = currentSelection.kind === "draft" ? null : currentSelection.target;
                    if (currentTarget?.kind === "continue") {
                        const session = await requests.continueNativeSession(
                            botId,
                            currentTarget.harness,
                            currentTarget.sessionId,
                            currentTarget.action,
                            signal,
                        );
                        signal.throwIfAborted();
                        options.navigation.showContinuedSession(session.result.ready.sessionId);
                        set({
                            view: { kind: "active", botId },
                            selection: transitionConversationSelection(get().selection, {
                                kind: "continued-session-loaded",
                                session,
                                target: currentTarget,
                            }),
                        });
                        announceSelection();
                        phase = "watch";
                        await followConfigurationChanges(signal);
                        return;
                    }
                    if (currentTarget?.kind === "session") {
                        const session = await requests.managedSession(botId, currentTarget.sessionId, signal);
                        signal.throwIfAborted();
                        set((current) => ({
                            view: { kind: "active", botId },
                            selection: transitionConversationSelection(current.selection, {
                                kind: "session-loaded",
                                session,
                                target: currentTarget,
                            }),
                        }));
                        announceSelection();
                        phase = "watch";
                        await followConfigurationChanges(signal);
                        return;
                    }
                    const reason = currentTarget === null ? setupReason(configuration) : null;
                    if (reason !== null) {
                        set((current) => ({
                            view: { kind: "setup", botId, reason },
                            ...(current.notices.pairing.kind === "visible"
                                ? { notices: { ...current.notices, pairing: { kind: "hidden" as const } } }
                                : {}),
                        }));
                        await watchRuntimeConfigurationChanges();
                        return;
                    }
                    if (currentTarget === null) {
                        set((current) => ({
                            view: { kind: "active", botId },
                            ...(current.notices.pairing.kind === "visible"
                                ? { notices: { ...current.notices, pairing: { kind: "hidden" as const } } }
                                : {}),
                        }));
                        await watchRuntimeConfigurationChanges();
                        return;
                    }
                    await conversations.getState().open(botId, currentTarget.conversationId, signal);
                    const openedConversation = conversations.getState().state;
                    if (openedConversation.kind !== "ready") {
                        if (openedConversation.kind === "failed" && openedConversation.code !== null) {
                            throw new CloudApiError(openedConversation.code, openedConversation.message);
                        }
                        throw new Error(
                            openedConversation.kind === "failed"
                                ? openedConversation.message
                                : "The Session could not be opened.",
                        );
                    }
                    set((current) => ({
                        view: { kind: "active", botId },
                        selection: transitionConversationSelection(current.selection, {
                            kind: "session-loaded",
                            session: openedConversation.session,
                            target: currentTarget,
                        }),
                    }));
                    announceSelection();
                    phase = "watch";
                    await followConfigurationChanges(signal);
                } catch (cause) {
                    if (signal.aborted) {
                        return;
                    }
                    const failedTarget = get().selection;
                    if (
                        restoredSessionId !== null &&
                        failedTarget.kind === "loading" &&
                        failedTarget.target.kind === "session" &&
                        failedTarget.target.sessionId === restoredSessionId &&
                        cause instanceof CloudApiError &&
                        ["NOT_FOUND", "session_not_found"].includes(cause.code)
                    ) {
                        restoredSessionId = null;
                        get().newConversation();
                        return;
                    }
                    if (cause instanceof DOMException && cause.name === "TimeoutError") {
                        set((current) => ({ revision: current.revision + 1 }));
                        onRestart();
                        return;
                    }
                    if (isChatBridgeError(cause)) {
                        configurationUnavailable();
                        // A dropped bridge is an ordinary failed call. An
                        // established conversation keeps whatever it showed, and
                        // the next user action reports its own failure; a load
                        // the user is still waiting on must not strand the page,
                        // so it becomes an operable failure state that keeps its
                        // target.
                        console.error("The Chat WebSocket bridge failed to complete a request.", cause);
                        const message = formatError(cause, "Chat is unavailable.");
                        const current = get();
                        if (current.selection.kind === "loading") {
                            // The selection never completed, so this load is a
                            // user request still in flight: it becomes an
                            // operable failure that keeps its target.
                            set({
                                selection: transitionConversationSelection(current.selection, {
                                    kind: "session-load-failed",
                                    message,
                                    target: current.selection.target,
                                }),
                                view: { kind: "failed", message },
                            });
                            return;
                        }
                        // Content is already on screen: the view stays, and the
                        // dropped watches are re-armed when the bridge returns.
                        await followConfigurationChanges(signal);
                        return;
                    }
                    if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                        const currentSelection = get().selection;
                        const failedSelection =
                            currentSelection.kind === "loading"
                                ? transitionConversationSelection(currentSelection, {
                                      kind: "session-load-failed",
                                      message: cause.message,
                                      target: currentSelection.target,
                                  })
                                : currentSelection;
                        set({
                            selection: failedSelection,
                            view: { kind: "setup", botId, reason: "agent-required" },
                        });
                        await requests.waitForRuntimeConfigurationChange(botId, signal);
                        signal.throwIfAborted();
                        set((current) => ({
                            selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                            revision: current.revision + 1,
                        }));
                        onRestart();
                        return;
                    }
                    const message = formatError(cause, "Chat is unavailable.");
                    const failedSelection = get().selection;
                    if (isRuntimeConnectionFailure(cause)) {
                        // The Runtime could not be reached. The page keeps following it, and the workspace retries
                        // what failed once the Runtime is back, as Reconnect would.
                        set({
                            selection:
                                failedSelection.kind === "loading"
                                    ? transitionConversationSelection(failedSelection, {
                                          kind: "session-load-failed",
                                          message,
                                          target: failedSelection.target,
                                      })
                                    : failedSelection,
                            view: { kind: "runtime-disconnected", botId, message },
                        });
                        options.onWaitingForRuntime();
                        await followConfigurationChanges(signal);
                        return;
                    }
                    if (failedSelection.kind === "loading") {
                        set({
                            selection: transitionConversationSelection(failedSelection, {
                                kind: "session-load-failed",
                                message,
                                target: failedSelection.target,
                            }),
                            view: phase === "watch" ? { kind: "active", botId } : { kind: "failed", message },
                        });
                        return;
                    }
                    set({ view: { kind: "failed", message } });
                }
            },
            newConversation: () => {
                restoredSessionId = null;
                composerAttachments.getState().clear();
                const current = get();
                if (current.view.kind !== "loading" && current.view.kind !== "failed") {
                    centralSessionStorage.remove(newConversationDraftEntry(current.view.botId));
                }
                options.navigation.showDraft();
                const draftKey = options.createId();
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, {
                        kind: "draft-selected",
                        key: draftKey,
                    }),
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draft: "",
                    draftKey,
                    draftSettings: null,
                    scrollFollowRevision: state.scrollFollowRevision + 1,
                    revision: state.view.kind === "active" ? state.revision : state.revision + 1,
                }));
                onDraftSelected();
                onSelectionTargeted(null);
                if (get().view.kind !== "active") {
                    onRestart();
                }
            },
            openManaged: (isExternal, id) => {
                restoredSessionId = null;
                composerAttachments.getState().clear();
                options.navigation.showManaged(isExternal, id);
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, {
                        kind: "target-selected",
                        target: { kind: "session", sessionId: id },
                    }),
                    creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                    draftSettings: null,
                    scrollFollowRevision: current.scrollFollowRevision + 1,
                    revision: current.revision + 1,
                }));
                onSelectionTargeted(id);
                onRestart();
            },
            retry: () => {
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                    revision: current.revision + 1,
                }));
                onRestart();
            },
            forkInstead: () => {
                const current = get().selection;
                if (current.kind === "failed" && current.target.kind === "continue") {
                    const target: ConversationTarget = { ...current.target, action: "fork" };
                    options.navigation.showForkInstead();
                    set((state) => ({
                        selection: transitionConversationSelection(state.selection, {
                            kind: "target-selected",
                            target,
                        }),
                        revision: state.revision + 1,
                    }));
                    onSelectionTargeted(selectedConversationId(get().selection));
                    onRestart();
                }
            },
            setDraft: (draft) => {
                const current = get();
                if (current.view.kind !== "loading" && current.view.kind !== "failed") {
                    const entry = newConversationDraftEntry(current.view.botId);
                    if (draft === "") {
                        centralSessionStorage.remove(entry);
                    } else {
                        centralSessionStorage.write(entry, draft);
                    }
                }
                set({ draft });
            },
            setDraftSettings: (draftSettings) => set({ draftSettings }),
            showPairingDialog: () => set({ pairingDialogOpen: true }),
            closePairingDialog: () => set({ pairingDialogOpen: false }),
            updateConversationTitle: (sessionId, title) =>
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, {
                        kind: "session-title-updated",
                        sessionId,
                        title,
                    }),
                })),
            initialMessageDelivered: (conversationId) =>
                set((state) => ({
                    firstMessages: transitionFirstMessages(state.firstMessages, { kind: "delivered", conversationId }),
                })),
            initialMessageRecoveryCleared: (conversationId, commandId) =>
                set((state) => ({
                    firstMessages: transitionFirstMessages(state.firstMessages, {
                        kind: "discarded",
                        conversationId,
                        commandId,
                    }),
                })),
            initialMessageUnconfirmed: (conversationId, journal) =>
                set((state) => ({
                    firstMessages: transitionFirstMessages(state.firstMessages, {
                        kind: "unconfirmed",
                        conversationId,
                        journal,
                    }),
                })),
            createConversation: async (signal) => {
                const current = get();
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const draft = current.draft;
                if (
                    attachmentState.kind === "reading" ||
                    current.view.kind !== "active" ||
                    current.selection.kind !== "draft" ||
                    current.draftSettings === null
                ) {
                    return false;
                }
                const activeBotId = current.view.botId;
                const commandId = current.selection.key;
                const settings = current.draftSettings;
                const content = draft.trim();
                const title = (
                    content ||
                    attachments
                        .map((attachment) =>
                            attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                        )
                        .join(", ")
                ).slice(0, 500);
                const queuedMessage = {
                    attachments,
                    commandId,
                    content,
                    summary: title,
                };
                let access: ChatAccess;
                if (
                    current.creation.kind === "draft-message-send-failed" &&
                    current.creation.message.commandId === commandId
                ) {
                    access = current.creation.access;
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            kind: "draft-message-retry-requested",
                        }),
                    }));
                } else {
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            kind: "draft-message-queued",
                            message: queuedMessage,
                        }),
                    }));
                    try {
                        access = await requests.createConversation(activeBotId, commandId, settings, signal, title);
                        signal.throwIfAborted();
                        set((state) => ({
                            creation: transitionConversationCreation(state.creation, {
                                access,
                                commandId,
                                kind: "session-created",
                            }),
                        }));
                    } catch (cause) {
                        signal.throwIfAborted();
                        set((state) => ({
                            creation: transitionConversationCreation(state.creation, {
                                commandId,
                                error: formatError(cause, "The Session could not be created."),
                                kind: "session-create-failed",
                            }),
                        }));
                        return false;
                    }
                }
                signal.throwIfAborted();
                const conversationId = access.conversationId;
                // The conversation exists, so its first message belongs to it from now on, whatever is on screen.
                // The page follows it only if the user is still on this draft.
                const sending = get().creation;
                const following = sending.kind === "draft-message-sending" && sending.message.commandId === commandId;
                let session: OpenMobiusSession | null = null;
                if (following) {
                    try {
                        session = requests.conversationSession(
                            access,
                            { kind: "idle" },
                            settings.workspaceLabel,
                            title,
                        );
                    } catch (cause) {
                        set((state) => ({
                            creation: transitionConversationCreation(state.creation, {
                                commandId,
                                error: formatError(cause, "The message could not be sent."),
                                kind: "draft-message-send-failed",
                            }),
                        }));
                        return false;
                    }
                    options.navigation.showManaged(false, conversationId);
                }
                set((state) => ({
                    firstMessages: transitionFirstMessages(state.firstMessages, {
                        kind: "queued",
                        conversationId,
                        message: queuedMessage,
                    }),
                    directoryRevision: state.directoryRevision + 1,
                    ...(session !== null
                        ? {
                              creation: transitionConversationCreation(state.creation, {
                                  commandId,
                                  kind: "conversation-created",
                              }),
                              draft: "",
                              scrollFollowRevision: state.scrollFollowRevision + 1,
                              selection: transitionConversationSelection(state.selection, {
                                  kind: "conversation-created",
                                  conversationId,
                                  session,
                              }),
                          }
                        : // The draft text was sent with this conversation, so it must not be offered again. A
                          // new draft started meanwhile owns whatever text the composer holds now.
                          state.draftKey === commandId
                          ? { draft: "" }
                          : {}),
                }));
                if (following) {
                    announceSelection();
                }
                onConversationCreated(conversationId, queuedMessage.summary);
                onDirectoryRefreshed();
                if (following) {
                    composerAttachments.getState().clear();
                }
                if (get().draftKey === commandId) {
                    centralSessionStorage.remove(newConversationDraftEntry(activeBotId));
                }
                return true;
            },
        };
    });
};
