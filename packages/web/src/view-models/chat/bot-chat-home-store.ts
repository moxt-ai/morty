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
    newConversationUnsentMessageEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import { type ComposerAttachmentStore, createComposerAttachmentStore } from "./composer-attachment-store.ts";
import {
    type ConversationCreationState,
    queuedDraftMessage,
    transitionConversationCreation,
} from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionEvent,
    type ConversationSelectionState,
    selectedConversationId,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";
import { type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { canRetryFirstMessage, canSendFirstMessage, type NewConversationFacts } from "./new-conversation-rules.ts";
import type { OpenMobiusSession } from "./open-session.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";
import type { RuntimeObservation } from "./runtime-recovery.ts";
import { prependToDraft, type SubmittedMessage } from "./session-delivery-store.ts";
import type { SessionTitles, SessionTitlesStore } from "./session-titles-store.ts";

export type BotChatHomeStoreApi = Omit<ReturnType<typeof createBotChatHomeStore>, "setState">;

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
 * is back. A selection that is loading again is a retry in flight, not a failure.
 */
export function homeWaitsForRuntime(home: Pick<BotChatHomeStore, "initialization" | "selection">): boolean {
    const selection = home.selection;
    if (selection.kind === "draft") {
        return false;
    }
    return (
        (home.initialization.kind === "failed" && home.initialization.failure === "runtime") ||
        (selection.kind === "failed" && selection.failure === "runtime")
    );
}

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (id: string) => void;
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
    /** The draft written while creating the Session the page followed, until that Session's composer takes it. */
    readonly draftHandoff: {
        readonly sessionId: string;
        readonly draft: string;
        readonly attachments: ReturnType<typeof createComposerAttachmentStore>;
    } | null;
    readonly initialization: HomeInitialization;
    readonly pairing: BotPairing;
    readonly runtimeConfiguration: BotRuntimeConfiguration | null;
    readonly configurationWatch:
        | { readonly kind: "checking" }
        | { readonly kind: "current"; readonly checkedAt: number }
        | {
              readonly kind: "unavailable";
              readonly lastCheckedAt: number | null;
              readonly notice: "quiet" | "visible";
          };
    readonly networkAvailable: boolean;
    readonly setNetworkAvailable: (available: boolean) => void;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
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
    readonly openManaged: (id: string) => void;
    readonly retry: () => void;
    readonly setDraft: (draft: string) => void;
    readonly showPairingDialog: () => void;
    readonly closePairingDialog: () => void;
    readonly createConversation: (signal: AbortSignal) => Promise<boolean>;
    /** Hands the draft written during creation to the Session the page followed; null for any other Session. */
    readonly takeNextDraft: (sessionId: string) => {
        readonly draft: string;
        readonly attachments: ReturnType<typeof createComposerAttachmentStore>;
    } | null;
}

function initialSelection(urlValue: string, createId: () => string): ConversationSelectionState {
    const sessionId = new URL(urlValue).searchParams.get("sessionId");
    return sessionId !== null && isIdentifier(sessionId)
        ? { kind: "pending", target: { kind: "session", sessionId } }
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

function newConversationFacts(
    home: BotChatHomeStore,
    settingsReady: boolean,
    connectionAvailable: boolean,
): NewConversationFacts {
    return {
        connectionAvailable,
        startable: homeCanStartConversation(home),
        draftSelected: home.selection.kind === "draft",
        settingsReady,
        creation: home.creation.kind,
    };
}

function composerMessage(
    home: Pick<BotChatHomeStore, "draft">,
    attachments: Pick<ComposerAttachmentStore, "attachments" | "state">,
) {
    return {
        draft: home.draft,
        attachmentCount: attachments.attachments.length,
        readingAttachments: attachments.state.kind === "reading",
    };
}

/** What the New Session page offers now: the composer's send control and a failed first message's Retry. */
export function newConversationPresentation(
    home: BotChatHomeStore,
    attachments: Pick<ComposerAttachmentStore, "attachments" | "state">,
    settings: DraftControlsStore["settings"],
    connectionAvailable: boolean,
) {
    const facts = newConversationFacts(home, draftConfiguration(settings) !== null, connectionAvailable);
    return {
        submitDisabled: !canSendFirstMessage(facts, composerMessage(home, attachments)),
        retryDisabled: !canRetryFirstMessage(facts),
    } as const;
}

export const createBotChatHomeStore = (
    requests: Pick<
        BotChatApi,
        | "access"
        | "conversationSession"
        | "createConversation"
        | "managedSession"
        | "readRuntimeBinding"
        | "waitForRuntimeBindingChange"
        | "waitForRuntimeConfigurationChange"
        | "runtimeConfiguration"
        | "directory"
        | "waitForBridge"
    >,
    options: {
        readonly botId: string;
        readonly titles: SessionTitlesStore;
        readonly draftConfiguration: () => ChatDraftConfiguration | null;
        /** Whether the connection header reports the New Session page's connection available, network and Machine included. */
        readonly connectionAvailable: () => boolean;
        readonly entry?: "address" | "restore";
        /**
         * Announced with every Runtime configuration the page observes, after the view follows it: the owner keeps the
         * other workspace workflows on it and retries what the Runtime failed once it is back.
         */
        readonly onRuntimeConfiguration: (
            configuration: BotRuntimeConfiguration,
            observation: RuntimeObservation,
        ) => void;
        /** Announced when the view failed only because the Runtime was unreachable and waits for it to be retried. */
        readonly onWaitingForRuntime: () => void;
        readonly clock: Clock;
        readonly url: string;
        readonly createId: () => string;
        readonly navigation: BotChatNavigation;
        /** Announced when the owner must restart the home and directory loads. */
        readonly onRestart: () => void;
        /** Announced when a created conversation joins the directory: the owner reloads it without reloading the home view. */
        readonly onDirectoryRefreshed: () => void;
        /**
         * Hands a created Session its first message: the Session's delivery owns it, durably, from this call until
         * the Runtime takes it, whichever conversation is on screen.
         */
        readonly onFirstMessage: (sessionId: string, message: SubmittedMessage) => void;
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
    const titles = options.titles;
    const selection = initialSelection(options.url, options.createId);
    let restoredSessionId =
        options.entry === "restore" && selection.kind === "pending" && selection.target.kind === "session"
            ? selection.target.sessionId
            : null;
    const { onRestart, onDirectoryRefreshed, onDraftSelected, onSelectionTargeted, onSelectionReady } = options;
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
                titles.getState().remember(selectedConversationId(selection));
                onSelectionReady(selection);
            }
        };
        const acceptLoadedSelection = (
            event: Extract<ConversationSelectionEvent, { readonly kind: "session-loaded" }>,
            startedWith: SessionTitles,
        ): void => {
            const previous = get().selection;
            const selection = transitionConversationSelection(previous, event);
            if (selection === previous) {
                return;
            }
            titles
                .getState()
                .sessionLoaded(event.session.result.ready.sessionId, event.session.entry.title, startedWith);
            set({ selection });
            announceSelection();
        };
        // The draft page's reload recovery of a first message ends once its Session owns it or the user leaves its draft.
        const releaseUnsentFirstMessage = (commandId: string): void => {
            const entry = newConversationUnsentMessageEntry(botId);
            if (centralSessionStorage.read(entry)?.commandId === commandId) {
                centralSessionStorage.remove(entry);
            }
        };
        const abandonFirstMessage = (): void => {
            const abandoned = queuedDraftMessage(get().creation);
            if (abandoned !== null) {
                releaseUnsentFirstMessage(abandoned.commandId);
            }
        };
        return {
            composerAttachments: createComposerAttachmentStore(),
            draftHandoff: null,
            initialization: { kind: "loading" },
            pairing: { kind: "checking" },
            runtimeConfiguration: null,
            configurationWatch: { kind: "checking" },
            networkAvailable: navigator.onLine,
            setNetworkAvailable: (available) => {
                set({ networkAvailable: available });
            },
            selection,
            creation: { kind: "draft" },
            draft: "",
            draftKey: selection.kind === "draft" ? selection.key : options.createId(),
            scrollFollowRevision: 0,
            pairingDialogOpen: false,
            notices: { pairing: { kind: "hidden" } },
            dismissNotice: () => set((current) => ({ notices: { ...current.notices, pairing: { kind: "hidden" } } })),
            load: async (signal) => {
                signal.throwIfAborted();
                let recoveryNotice: AbortController | null = null;
                const clearRecoveryNotice = (): void => {
                    recoveryNotice?.abort();
                    recoveryNotice = null;
                };
                const configurationUnavailable = (): void => {
                    const watch = get().configurationWatch;
                    // Repeated failures belong to one interruption, so they cannot postpone its notice.
                    if (recoveryNotice !== null) {
                        return;
                    }
                    const notice =
                        watch.kind === "current" ? "quiet" : watch.kind === "unavailable" ? watch.notice : "visible";
                    set({
                        configurationWatch: {
                            kind: "unavailable",
                            lastCheckedAt:
                                watch.kind === "current"
                                    ? watch.checkedAt
                                    : watch.kind === "unavailable"
                                      ? watch.lastCheckedAt
                                      : null,
                            notice,
                        },
                    });
                    if (notice === "visible") {
                        return;
                    }
                    recoveryNotice = startRecoveryNotice({
                        clock: options.clock,
                        signal,
                        onNotice: (notice) => {
                            const current = get().configurationWatch;
                            if (current.kind === "unavailable") {
                                set({ configurationWatch: { ...current, notice } });
                            }
                        },
                    });
                };
                titles.getState().restore();
                const startedWith = titles.getState().titles;
                const starting = get();
                if (starting.initialization.kind !== "ready") {
                    set({ initialization: { kind: "loading" } });
                }
                if (starting.initialization.kind === "loading" && starting.selection.kind === "draft") {
                    const draft = centralSessionStorage.read(newConversationDraftEntry(botId)) ?? "";
                    // A first message an earlier page could not hand to a Session returns ahead of the draft.
                    const unsent = centralSessionStorage.read(newConversationUnsentMessageEntry(botId));
                    if (unsent === null) {
                        set({ draft });
                    } else {
                        const restored = prependToDraft(unsent.content, draft);
                        centralSessionStorage.write(newConversationDraftEntry(botId), restored);
                        centralSessionStorage.remove(newConversationUnsentMessageEntry(botId));
                        set({ draft: restored });
                    }
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
                    clearRecoveryNotice();
                    set({
                        runtimeConfiguration: configuration,
                        configurationWatch: { kind: "current", checkedAt: options.clock.now() },
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
                                const binding = await requests.readRuntimeBinding(botId, watchSignal);
                                watchSignal.throwIfAborted();
                                set({ pairing: { kind: binding.kind === "bound" ? "paired" : "unpaired" } });
                                if (binding.kind === "unbound") {
                                    // An unbound Machine waits for the binding
                                    // it just read to change; the pairing flow
                                    // completes by restarting the load.
                                    await requests.waitForRuntimeBindingChange(botId, watchSignal);
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
                            // A bound Machine keeps following workspace
                            // changes even while its Runtime is offline.
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
                        acceptLoadedSelection({ kind: "session-loaded", session, target }, startedWith);
                        phase = "watch";
                        await followConfigurationChanges(signal);
                        return;
                    }
                    const binding = await requests.readRuntimeBinding(botId, signal);
                    signal.throwIfAborted();
                    set({ pairing: { kind: binding.kind === "bound" ? "paired" : "unpaired" } });
                    if (binding.kind === "unbound") {
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
                    const currentTarget = currentSelection.kind === "draft" ? null : currentSelection.target;
                    if (currentTarget?.kind === "session") {
                        const session = await requests.managedSession(botId, currentTarget.sessionId, signal);
                        signal.throwIfAborted();
                        acceptLoadedSelection({ kind: "session-loaded", session, target: currentTarget }, startedWith);
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
                    acceptLoadedSelection(
                        { kind: "session-loaded", session: openedConversation.session, target: currentTarget },
                        startedWith,
                    );
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
                        )
                    ) {
                        titles.getState().forget(selectedConversationId(failedTarget));
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
                } finally {
                    // Quiet feedback is owned by an active recovery. Once this load exits,
                    // an unavailable watch needs the manual retry entry point immediately.
                    const watch = get().configurationWatch;
                    if (!signal.aborted && watch.kind === "unavailable") {
                        set({ configurationWatch: { ...watch, notice: "visible" } });
                    }
                    clearRecoveryNotice();
                }
            },
            newConversation: () => {
                restoredSessionId = null;
                abandonFirstMessage();
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
            openManaged: (id) => {
                restoredSessionId = null;
                abandonFirstMessage();
                get().composerAttachments.getState().clear();
                options.navigation.showManaged(id);
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
            createConversation: async (signal) => {
                const current = get();
                const composer = get().composerAttachments.getState();
                const { attachments } = composer;
                const draft = current.draft;
                const settings = options.draftConfiguration();
                const facts = newConversationFacts(current, settings !== null, options.connectionAvailable());
                const allowed =
                    current.creation.kind === "draft"
                        ? canSendFirstMessage(facts, composerMessage(current, composer))
                        : canRetryFirstMessage(facts);
                // The rule already requires both; checking them again narrows their types.
                if (!allowed || settings === null || current.selection.kind !== "draft") {
                    return false;
                }
                const commandId = current.selection.key;
                const content = draft.trim();
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
                    if (content.length > 0) {
                        centralSessionStorage.write(newConversationUnsentMessageEntry(botId), { commandId, content });
                    }
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
                const conversationId = access.sessionId;
                titles.getState().created(conversationId, queuedMessage.summary);
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
                    options.navigation.showManaged(conversationId);
                }
                // The Session takes the message and its durable copy in one step, so a reload always finds one.
                options.onFirstMessage(conversationId, {
                    commandId,
                    content: queuedMessage.content,
                    attachments: { kind: "local", values: queuedMessage.attachments },
                    target: { disposition: "reject", targetCommandId: "" },
                });
                releaseUnsentFirstMessage(commandId);
                if (session !== null) {
                    set((state) => ({
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
                        // The attachment store moves with the draft, including any read still in progress.
                        draftHandoff: {
                            sessionId: conversationId,
                            draft: state.draft,
                            attachments: state.composerAttachments,
                        },
                        draft: "",
                        composerAttachments: createComposerAttachmentStore(),
                    }));
                    centralSessionStorage.remove(newConversationDraftEntry(botId));
                    announceSelection();
                }
                onDirectoryRefreshed();
                return true;
            },
            takeNextDraft: (sessionId) => {
                const handoff = get().draftHandoff;
                if (handoff === null || handoff.sessionId !== sessionId) {
                    return null;
                }
                set({ draftHandoff: null });
                return { draft: handoff.draft, attachments: handoff.attachments };
            },
        };
    });
};
