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
import { type ConversationCreationState, transitionConversationCreation } from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionState,
    type ConversationTarget,
    selectedConversationId,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";
import type { UnconfirmedSubmission } from "./session-delivery-store.ts";

export type BotChatHomeStoreApi = ReturnType<typeof createBotChatHomeStore>;

export type SetupReason = "unconfigured" | "agent-missing" | "runtime-offline" | "agent-required";

/**
 * A page serves exactly one Bot: the one provisioned with the active
 * identity. Views carry its identifier; the Bot has no user-facing name.
 */
type BotView = { readonly botId: string };
export type BotChatHomeView =
    | { readonly kind: "loading" }
    | ({ readonly kind: "connecting" } & BotView)
    | ({ readonly kind: "active" } & BotView)
    | ({ readonly kind: "setup"; readonly reason: SetupReason } & BotView)
    | ({ readonly kind: "runtime-disconnected"; readonly message: string } & BotView)
    | { readonly kind: "failed"; readonly message: string };

export type BotConnectionStatus =
    | { readonly kind: "connecting"; readonly label: "Connecting" }
    | { readonly kind: "connected"; readonly label: "Connected" }
    | { readonly kind: "unpaired"; readonly label: "Disconnected" }
    | { readonly kind: "disconnected"; readonly label: "Disconnected" };

export type DisconnectedBotNotice =
    | { readonly kind: "hidden" }
    | { readonly description: string; readonly kind: "visible"; readonly title: string };

export function disconnectedBotNotice(
    view: BotChatHomeView,
    connectionStatus: BotConnectionStatus,
): DisconnectedBotNotice {
    if (connectionStatus.kind !== "disconnected") {
        return { kind: "hidden" };
    }
    switch (view.kind) {
        case "active":
        case "runtime-disconnected":
            return {
                kind: "visible",
                title: "Your agent is disconnected",
                description: "Start your local agent to reconnect it and use its sessions.",
            };
        case "setup":
            return view.reason === "unconfigured"
                ? { kind: "hidden" }
                : {
                      kind: "visible",
                      title: "Your agent is disconnected",
                      description: "Start your local agent to reconnect it and use its sessions.",
                  };
        case "loading":
        case "connecting":
        case "failed":
            return { kind: "hidden" };
    }
}

function runtimeConnectionStatus(configuration: BotRuntimeConfiguration): BotConnectionStatus {
    return configuration.runtime.online
        ? { kind: "connected", label: "Connected" }
        : { kind: "disconnected", label: "Disconnected" };
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
    readonly connectionStatus: BotConnectionStatus;
    readonly runtimeConfiguration: BotRuntimeConfiguration | null;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    readonly revision: number;
    readonly directoryRevision: number;
    readonly draft: string;
    readonly draftSettings: ChatDraftConfiguration | null;
    /** Bumped whenever the message list should re-arm following the latest message. */
    readonly scrollFollowRevision: number;
    /** The pairing dialog the user opened manually from the sidebar. */
    readonly pairingDialogOpen: boolean;
    /** Set once the user dismisses the disconnected-agent toast for this disconnect. */
    readonly disconnectedNoticeDismissed: boolean;
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
    readonly dismissDisconnectedNotice: () => void;
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
    >,
    options: {
        readonly botId: string;
        readonly entry?: "address" | "restore";
        readonly onRuntimeConfiguration?: (configuration: BotRuntimeConfiguration) => void;
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
        return {
            composerAttachments,
            view: { kind: "loading" },
            connectionStatus: { kind: "connecting", label: "Connecting" },
            runtimeConfiguration: null,
            selection,
            creation: { kind: "draft" },
            revision: 0,
            directoryRevision: 0,
            draft: "",
            draftSettings: null,
            scrollFollowRevision: 0,
            pairingDialogOpen: false,
            disconnectedNoticeDismissed: false,
            notices: { pairing: { kind: "hidden" } },
            dismissNotice: () => set((current) => ({ notices: { ...current.notices, pairing: { kind: "hidden" } } })),
            load: async (signal) => {
                set((current) => ({ view: "botId" in current.view ? current.view : { kind: "loading" } }));
                let opened = false;
                const watchRuntimeConfigurationChanges = async (): Promise<void> => {
                    while (true) {
                        try {
                            await requests.waitForRuntimeConfigurationChange(botId, signal);
                        } catch (cause) {
                            if (cause instanceof DOMException && cause.name === "TimeoutError") {
                                continue;
                            }
                            throw cause;
                        }
                        signal.throwIfAborted();
                        const changedConfiguration = await requests.runtimeConfiguration(botId, signal);
                        signal.throwIfAborted();
                        options.onRuntimeConfiguration?.(changedConfiguration);
                        const changedReason = setupReason(changedConfiguration);
                        set((current) =>
                            current.selection.kind === "draft"
                                ? {
                                      runtimeConfiguration: changedConfiguration,
                                      connectionStatus: runtimeConnectionStatus(changedConfiguration),
                                      view:
                                          changedReason === null
                                              ? { kind: "active", botId }
                                              : { kind: "setup", botId, reason: changedReason },
                                  }
                                : {
                                      runtimeConfiguration: changedConfiguration,
                                      connectionStatus: runtimeConnectionStatus(changedConfiguration),
                                  },
                        );
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
                        opened = true;
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
                        await watchRuntimeConfigurationChanges();
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
                    opened = true;
                    const detail = await requests.readBot(botId, signal);
                    signal.throwIfAborted();
                    if (!detail.configured) {
                        set((current) => ({
                            connectionStatus: { kind: "unpaired", label: "Disconnected" },
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
                        await requests.waitForSetupChange(botId, signal);
                        signal.throwIfAborted();
                        set((current) => ({
                            selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                            revision: current.revision + 1,
                        }));
                        onRestart();
                        return;
                    }
                    const configuration = await requests.runtimeConfiguration(botId, signal);
                    signal.throwIfAborted();
                    set({
                        runtimeConfiguration: configuration,
                        connectionStatus: runtimeConnectionStatus(configuration),
                    });
                    options.onRuntimeConfiguration?.(configuration);
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
                        await watchRuntimeConfigurationChanges();
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
                        await watchRuntimeConfigurationChanges();
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
                    await watchRuntimeConfigurationChanges();
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
                        // A dropped bridge leaves the view alone: Chat keeps
                        // whatever it showed. The next user action retries
                        // through the normal call path and reports its own
                        // failure, exactly like any other failed request.
                        console.error("The Chat WebSocket bridge failed to complete a request.", cause);
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
                    const runtimeFailure = isRuntimeConnectionFailure(cause);
                    const failedSelection = get().selection;
                    if (failedSelection.kind === "loading") {
                        set({
                            selection: transitionConversationSelection(failedSelection, {
                                kind: "session-load-failed",
                                message,
                                target: failedSelection.target,
                            }),
                            view: opened
                                ? runtimeFailure
                                    ? { kind: "runtime-disconnected", botId, message }
                                    : { kind: "active", botId }
                                : { kind: "failed", message },
                            ...(runtimeFailure
                                ? {
                                      connectionStatus: {
                                          kind: "disconnected" as const,
                                          label: "Disconnected" as const,
                                      },
                                      disconnectedNoticeDismissed: false,
                                  }
                                : {}),
                        });
                        return;
                    }
                    if (opened && runtimeFailure) {
                        set((current) => ({
                            connectionStatus: { kind: "disconnected", label: "Disconnected" },
                            disconnectedNoticeDismissed:
                                current.connectionStatus.kind === "disconnected"
                                    ? current.disconnectedNoticeDismissed
                                    : false,
                            view: { kind: "runtime-disconnected", botId, message },
                        }));
                        try {
                            await requests.waitForRuntimeConfigurationChange(botId, signal);
                            signal.throwIfAborted();
                            set((current) => ({ revision: current.revision + 1 }));
                            onRestart();
                        } catch (watchCause) {
                            if (signal.aborted) {
                                return;
                            }
                            if (watchCause instanceof DOMException && watchCause.name === "TimeoutError") {
                                set((current) => ({ revision: current.revision + 1 }));
                                onRestart();
                                return;
                            }
                            throw watchCause;
                        }
                        return;
                    }
                    set((current) => ({
                        connectionStatus:
                            current.connectionStatus.kind === "connecting" || runtimeFailure
                                ? { kind: "disconnected", label: "Disconnected" }
                                : current.connectionStatus,
                        view: { kind: "failed", message },
                    }));
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
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, {
                        kind: "draft-selected",
                        key: options.createId(),
                    }),
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draft: "",
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
            dismissDisconnectedNotice: () => set({ disconnectedNoticeDismissed: true }),
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
                    creation: transitionConversationCreation(state.creation, {
                        conversationId,
                        kind: "initial-message-delivered",
                    }),
                })),
            initialMessageRecoveryCleared: (conversationId, commandId) =>
                set((state) => ({
                    creation: transitionConversationCreation(state.creation, {
                        commandId,
                        conversationId,
                        kind: "initial-message-discarded",
                    }),
                })),
            initialMessageUnconfirmed: (conversationId, journal) =>
                set((state) => {
                    const creation = transitionConversationCreation(state.creation, {
                        journal,
                        kind: "initial-message-unconfirmed",
                    });
                    return creation.kind === "initial-message-unconfirmed" && creation.conversationId === conversationId
                        ? { creation }
                        : {};
                }),
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
                const sending = get().creation;
                if (sending.kind !== "draft-message-sending" || sending.message.commandId !== commandId) {
                    return false;
                }
                try {
                    signal.throwIfAborted();
                    const session = requests.conversationSession(
                        access,
                        { kind: "idle" },
                        settings.workspaceLabel,
                        title,
                    );
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            conversationId: access.conversationId,
                            kind: "initial-message-pending",
                            session,
                        }),
                    }));
                    const sent = get().creation;
                    if (sent.kind !== "initial-message-pending") {
                        return false;
                    }
                    options.navigation.showManaged(false, sent.conversationId);
                    set((state) => ({
                        draft: "",
                        scrollFollowRevision: state.scrollFollowRevision + 1,
                        selection: transitionConversationSelection(state.selection, {
                            kind: "conversation-created",
                            conversationId: sent.conversationId,
                            session: sent.session,
                        }),
                        directoryRevision: state.directoryRevision + 1,
                    }));
                    announceSelection();
                    onConversationCreated(sent.conversationId, sent.message.summary);
                    onDirectoryRefreshed();
                    composerAttachments.getState().clear();
                    centralSessionStorage.remove(newConversationDraftEntry(activeBotId));
                    return true;
                } catch (cause) {
                    signal.throwIfAborted();
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            error: formatError(cause, "The message could not be sent."),
                            kind: "draft-message-send-failed",
                        }),
                    }));
                    return false;
                }
            },
        };
    });
};
