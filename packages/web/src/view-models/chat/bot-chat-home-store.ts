import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
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
    type RememberedSession,
    rememberedSessionEntry,
} from "../../services/session-storage/central-session-storage.ts";
import { formatError } from "../format-error.ts";
import { createComposerAttachmentStore } from "./composer-attachment-store.ts";
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

export type BotChatHomeStoreApi = ReturnType<typeof createBotChatHomeStore>;

type SetupReason = "unconfigured" | "agent-missing" | "runtime-offline" | "agent-required";

/** Initialization owns only the entry request, never the selected session or the Runtime's availability. */
type HomeInitialization =
    | { readonly kind: "loading" }
    | { readonly kind: "ready" }
    | {
          readonly kind: "failed";
          readonly failure: "runtime" | "agent-required" | "unavailable";
          readonly message: string;
      };

type BotPairing = { readonly kind: "checking" } | { readonly kind: "paired" } | { readonly kind: "unpaired" };

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
    home: Pick<BotChatHomeStore, "runtimeConfiguration" | "pairing" | "configurationWatch" | "networkAvailable">,
): BotConnectionStatus {
    if (home.pairing.kind === "unpaired") {
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
    return { kind: "connecting", label: "Connecting" };
}

/**
 * Whether the home view failed only because the Runtime was unreachable, so the workspace retries it once the Runtime
 * is back. A selection that is loading again is a retry in flight, not a failure. Only loads that read are retried:
 * continuing a native session forks or imports it, and a connection that dropped mid-request cannot show it did not
 * happen, so the user decides whether to retry.
 */
export function homeWaitsForRuntime(home: Pick<BotChatHomeStore, "initialization" | "selection">): boolean {
    const selection = home.selection;
    if (selection.kind === "draft" || selection.target.kind === "continue") {
        return false;
    }
    return (
        (home.initialization.kind === "failed" && home.initialization.failure === "runtime") ||
        (selection.kind === "failed" && selection.failure === "runtime")
    );
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
    readonly initialization: HomeInitialization;
    readonly pairing: BotPairing;
    readonly runtimeConfiguration: BotRuntimeConfiguration | null;
    readonly configurationWatch:
        | { readonly kind: "checking" }
        | { readonly kind: "current"; readonly checkedAt: number }
        | { readonly kind: "unavailable"; readonly lastCheckedAt: number | null };
    readonly networkAvailable: boolean;
    readonly setNetworkAvailable: (available: boolean) => void;
    readonly selection: ConversationSelectionState;
    readonly rememberedSession: RememberedSession | null;
    readonly creation: ConversationCreationState;
    /** First messages waiting to enter their Session's delivery workflow, whichever is on screen. */
    readonly firstMessages: FirstMessages;
    readonly draft: string;
    /** The draft the composer text belongs to. Only starting a new draft changes it. */
    readonly draftKey: string;
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
    readonly showPairingDialog: () => void;
    readonly closePairingDialog: () => void;
    readonly updateConversationTitle: (sessionId: string, title: string) => void;
    /** Releases the first message to delivery, or back to an editable composer if preparation failed. */
    readonly initialMessageDequeued: (conversationId: string, commandId: string) => void;
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
                      kind: "pending",
                      target:
                          requestedAction === "import"
                              ? { kind: "continue", action: "import", harness, sessionId }
                              : {
                                    kind: "continue",
                                    action: "fork",
                                    harness,
                                    sessionId,
                                    operation: { id: createId(), contract: "undecided" },
                                },
                  }
                : { kind: "draft", key: createId() };
        }
        return { kind: "pending", target: { kind: "session", sessionId } };
    }
    const conversationId = url.searchParams.get("conversationId");
    return conversationId !== null && isIdentifier(conversationId)
        ? { kind: "pending", target: { kind: "conversation", conversationId } }
        : { kind: "draft", key: createId() };
}

/** Setup is a projection of its owning workflows, not a second stored configuration snapshot. */
function homeSetupReason(home: BotChatHomeStore): SetupReason | null {
    if (home.pairing.kind === "unpaired") {
        return "unconfigured";
    }
    if (
        (home.selection.kind === "failed" && home.selection.failure === "agent-required") ||
        (home.initialization.kind === "failed" && home.initialization.failure === "agent-required")
    ) {
        return "agent-required";
    }
    if (home.selection.kind !== "draft" || home.runtimeConfiguration === null) {
        return null;
    }
    if (home.runtimeConfiguration.runtime.agents.length === 0) {
        return "agent-missing";
    }
    return home.runtimeConfiguration.runtime.online ? null : "runtime-offline";
}

export function homeCanStartConversation(home: BotChatHomeStore): boolean {
    return (
        home.initialization.kind === "ready" &&
        home.pairing.kind === "paired" &&
        home.runtimeConfiguration !== null &&
        homeSetupReason(home) === null
    );
}

export const createBotChatHomeStore = (
    requests: Pick<
        BotChatApi,
        | "access"
        | "conversationSession"
        | "continueNativeSession"
        | "continueRecoverableNativeFork"
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
        readonly identityKey: string | null;
        readonly draftConfiguration: () => ChatDraftConfiguration | null;
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
        /** Announced when the owner must restart the home and directory loads. */
        readonly onRestart: () => void;
        /** Announced when a created conversation joins the directory: the owner reloads it without reloading the home view. */
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
    const conversations = createConversationSessionStore(requests);
    const selection = initialSelection(options.url, options.createId);
    let restoredSessionId =
        options.entry === "restore" && selection.kind === "pending" && selection.target.kind === "session"
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
                const rememberedSession = {
                    id: selectedConversationId(selection),
                    title: selection.session.entry.title,
                };
                set({ rememberedSession });
                if (options.identityKey !== null) {
                    centralSessionStorage.write(rememberedSessionEntry(options.identityKey), rememberedSession);
                }
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
            composerAttachments: createComposerAttachmentStore(),
            initialization: { kind: "loading" },
            pairing: { kind: "checking" },
            runtimeConfiguration: null,
            configurationWatch: { kind: "checking" },
            networkAvailable: navigator.onLine,
            setNetworkAvailable: (available) => {
                set({ networkAvailable: available });
            },
            selection,
            rememberedSession: null,
            creation: { kind: "draft" },
            firstMessages: new Map(),
            draft: "",
            draftKey: selection.kind === "draft" ? selection.key : options.createId(),
            scrollFollowRevision: 0,
            pairingDialogOpen: false,
            notices: { pairing: { kind: "hidden" } },
            dismissNotice: () => set((current) => ({ notices: { ...current.notices, pairing: { kind: "hidden" } } })),
            load: async (signal) => {
                signal.throwIfAborted();
                if (options.identityKey !== null) {
                    set({ rememberedSession: centralSessionStorage.read(rememberedSessionEntry(options.identityKey)) });
                }
                const starting = get();
                if (starting.initialization.kind !== "ready") {
                    set({ initialization: { kind: "loading" } });
                }
                if (starting.initialization.kind === "loading" && starting.selection.kind === "draft") {
                    set({ draft: centralSessionStorage.read(newConversationDraftEntry(botId)) ?? "" });
                }
                // Entry failures and session failures belong to the request that failed.
                const failLoad = (
                    failure: "runtime" | "agent-required" | "unavailable" | "connection",
                    message: string,
                ): void => {
                    const current = get();
                    if (current.selection.kind === "loading") {
                        set({
                            selection: transitionConversationSelection(current.selection, {
                                kind: "session-load-failed",
                                failure,
                                message,
                                target: current.selection.target,
                            }),
                        });
                    } else {
                        set({
                            initialization: {
                                kind: "failed",
                                failure: failure === "connection" ? "unavailable" : failure,
                                message,
                            },
                        });
                    }
                };
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
                    if (get().selection.kind === "draft") {
                        // A recovered configuration read completes draft initialization after a bridge drop.
                        set({ initialization: { kind: "ready" } });
                    }
                    observeConfiguration(configuration, { kind: "watch", afterChange });
                };
                /** Records the authoritative snapshot and announces it to the other workspace workflows. */
                const observeConfiguration = (
                    configuration: BotRuntimeConfiguration,
                    observation: RuntimeObservation,
                ): void => {
                    set({
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
                                set({ pairing: { kind: detail.configured ? "paired" : "unpaired" } });
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
                        homeCanStartConversation(current) &&
                        botConnectionStatus(current).kind === "connected" &&
                        (current.selection.kind === "pending" || current.selection.kind === "loading") &&
                        current.selection.target.kind === "session"
                    ) {
                        const target = current.selection.target;
                        set({
                            selection: transitionConversationSelection(current.selection, {
                                kind: "session-load-started",
                            }),
                        });
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
                    const detail = await requests.readBot(botId, signal);
                    signal.throwIfAborted();
                    set({ pairing: { kind: detail.configured ? "paired" : "unpaired" } });
                    if (!detail.configured) {
                        set((current) => ({
                            selection:
                                current.selection.kind === "pending" || current.selection.kind === "loading"
                                    ? transitionConversationSelection(current.selection, {
                                          kind: "session-load-failed",
                                          failure: "unavailable",
                                          message: "Connect your local agent to load this session.",
                                          target: current.selection.target,
                                      })
                                    : current.selection,
                            initialization: { kind: "ready" },
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
                    set((current) => ({
                        initialization: { kind: "ready" },
                        selection: transitionConversationSelection(current.selection, {
                            kind: "session-load-started",
                        }),
                    }));
                    observeConfiguration(configuration, { kind: "read" });
                    const currentSelection = get().selection;
                    if (currentSelection.kind === "ready") {
                        set((current) => ({
                            ...(current.notices.pairing.kind === "visible"
                                ? { notices: { ...current.notices, pairing: { kind: "hidden" as const } } }
                                : {}),
                        }));
                        await watchRuntimeConfigurationChanges();
                        return;
                    }
                    let currentTarget = currentSelection.kind === "draft" ? null : currentSelection.target;
                    if (currentTarget?.kind === "continue") {
                        if (currentTarget.action === "fork" && currentTarget.operation.contract === "undecided") {
                            currentTarget = {
                                ...currentTarget,
                                operation: {
                                    id: currentTarget.operation.id,
                                    contract: configuration.runtime.nativeForkRecovery ? "recoverable" : "legacy",
                                },
                            };
                            set({ selection: { kind: "loading", target: currentTarget } });
                        }
                        const session =
                            currentTarget.action === "fork" && currentTarget.operation.contract === "recoverable"
                                ? await requests.continueRecoverableNativeFork(
                                      botId,
                                      currentTarget.harness,
                                      currentTarget.sessionId,
                                      currentTarget.operation.id,
                                      signal,
                                  )
                                : await requests.continueNativeSession(
                                      botId,
                                      currentTarget.harness,
                                      currentTarget.sessionId,
                                      currentTarget.action,
                                      signal,
                                  );
                        signal.throwIfAborted();
                        options.navigation.showContinuedSession(session.result.ready.sessionId);
                        set({
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
                    if (currentTarget === null) {
                        set((current) => ({
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
                        cause instanceof CloudApiError &&
                        ["NOT_FOUND", "SESSION_NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED"].includes(
                            cause.code.toUpperCase(),
                        ) &&
                        get().rememberedSession?.id === selectedConversationId(failedTarget)
                    ) {
                        set({ rememberedSession: null });
                        if (options.identityKey !== null) {
                            centralSessionStorage.remove(rememberedSessionEntry(options.identityKey));
                        }
                    }
                    if (
                        restoredSessionId !== null &&
                        (failedTarget.kind === "pending" || failedTarget.kind === "loading") &&
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
                        if (current.selection.kind === "pending" || current.selection.kind === "loading") {
                            // The selection never completed, so this load is a
                            // user request still in flight: it becomes an
                            // operable failure that keeps its target.
                            failLoad("connection", message);
                            return;
                        }
                        // Content is already on screen: the view stays, and the
                        // dropped watches are re-armed when the bridge returns.
                        await followConfigurationChanges(signal);
                        return;
                    }
                    if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                        failLoad("agent-required", cause.message);
                        await requests.waitForRuntimeConfigurationChange(botId, signal);
                        signal.throwIfAborted();
                        set((current) => ({
                            selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                        }));
                        onRestart();
                        return;
                    }
                    const message = formatError(cause, "Chat is unavailable.");
                    if (isRuntimeConnectionFailure(cause)) {
                        // Only a failed read is eligible for automatic replay; it does not assert the computer is offline.
                        failLoad("runtime", message);
                        options.onWaitingForRuntime();
                        await followConfigurationChanges(signal);
                        return;
                    }
                    failLoad("unavailable", message);
                }
            },
            newConversation: () => {
                restoredSessionId = null;
                get().composerAttachments.getState().clear();
                const current = get();
                centralSessionStorage.remove(newConversationDraftEntry(botId));
                // Leaving a pending selection releases its request, even when entry configuration is already ready.
                const restart =
                    !homeCanStartConversation(current) ||
                    current.selection.kind === "pending" ||
                    current.selection.kind === "loading" ||
                    current.selection.kind === "failed";
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
                    scrollFollowRevision: state.scrollFollowRevision + 1,
                }));
                onDraftSelected();
                onSelectionTargeted(null);
                if (restart) {
                    onRestart();
                }
            },
            openManaged: (isExternal, id) => {
                restoredSessionId = null;
                get().composerAttachments.getState().clear();
                options.navigation.showManaged(isExternal, id);
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, {
                        kind: "target-selected",
                        target: { kind: "session", sessionId: id },
                    }),
                    creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                    scrollFollowRevision: current.scrollFollowRevision + 1,
                }));
                onSelectionTargeted(id);
                onRestart();
            },
            retry: () => {
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                }));
                onRestart();
            },
            forkInstead: () => {
                const current = get().selection;
                if (current.kind === "failed" && current.target.kind === "continue") {
                    const target: ConversationTarget = {
                        ...current.target,
                        action: "fork",
                        operation: { id: options.createId(), contract: "undecided" },
                    };
                    options.navigation.showForkInstead();
                    set((state) => ({
                        selection: transitionConversationSelection(state.selection, {
                            kind: "target-selected",
                            target,
                        }),
                    }));
                    onSelectionTargeted(selectedConversationId(get().selection));
                    onRestart();
                }
            },
            setDraft: (draft) => {
                const entry = newConversationDraftEntry(botId);
                if (draft === "") {
                    centralSessionStorage.remove(entry);
                } else {
                    centralSessionStorage.write(entry, draft);
                }
                set({ draft });
            },
            showPairingDialog: () => set({ pairingDialogOpen: true }),
            closePairingDialog: () => set({ pairingDialogOpen: false }),
            updateConversationTitle: (sessionId, title) => {
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, {
                        kind: "session-title-updated",
                        sessionId,
                        title,
                    }),
                }));
                const selection = get().selection;
                if (selection.kind === "ready" && selection.session.result.ready.sessionId === sessionId) {
                    const rememberedSession = { id: selectedConversationId(selection), title };
                    set({ rememberedSession });
                    if (options.identityKey !== null) {
                        centralSessionStorage.write(rememberedSessionEntry(options.identityKey), rememberedSession);
                    }
                }
            },
            initialMessageDequeued: (conversationId, commandId) =>
                set((state) => ({
                    firstMessages: transitionFirstMessages(state.firstMessages, {
                        kind: "dequeued",
                        conversationId,
                        commandId,
                    }),
                })),
            createConversation: async (signal) => {
                const current = get();
                const { attachments, state: attachmentState } = get().composerAttachments.getState();
                const draft = current.draft;
                const settings = options.draftConfiguration();
                if (
                    (current.creation.kind === "draft" && attachmentState.kind === "reading") ||
                    !homeCanStartConversation(current) ||
                    current.selection.kind !== "draft" ||
                    settings === null ||
                    current.creation.kind === "session-creating" ||
                    current.creation.kind === "draft-message-sending"
                ) {
                    return false;
                }
                const commandId = current.selection.key;
                const content = draft.trim();
                if (current.creation.kind === "draft" && content.length === 0 && attachments.length === 0) {
                    return false;
                }
                const queuedMessage =
                    current.creation.kind === "draft"
                        ? {
                              attachments,
                              commandId,
                              content,
                              summary: (content || attachments.map((attachment) => attachment.name).join(", ")).slice(
                                  0,
                                  500,
                              ),
                          }
                        : current.creation.message;
                const title = queuedMessage.summary;
                if (current.creation.kind === "draft") {
                    // The submitted snapshot owns its content before any network work begins.
                    get().composerAttachments.getState().clear();
                    centralSessionStorage.remove(newConversationDraftEntry(botId));
                }
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
                        ...(current.creation.kind === "draft" ? { draft: "" } : {}),
                    }));
                    try {
                        access = await requests.createConversation(botId, commandId, settings, signal, title);
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
                    ...(session !== null
                        ? {
                              creation: transitionConversationCreation(state.creation, {
                                  commandId,
                                  kind: "conversation-created",
                              }),
                              scrollFollowRevision: state.scrollFollowRevision + 1,
                              selection: transitionConversationSelection(state.selection, {
                                  kind: "conversation-created",
                                  conversationId,
                                  session,
                              }),
                          }
                        : {}),
                }));
                if (following) {
                    announceSelection();
                }
                onConversationCreated(conversationId, queuedMessage.summary);
                onDirectoryRefreshed();
                if (following) {
                    // The pane took the next draft, including any attachment read still in progress.
                    set({ draft: "", composerAttachments: createComposerAttachmentStore() });
                    centralSessionStorage.remove(newConversationDraftEntry(botId));
                }
                return true;
            },
        };
    });
};
