import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { createStore } from "zustand/vanilla";
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
import type { ComposerAttachment } from "./composer-attachment.ts";
import { type ConversationCreationState, transitionConversationCreation } from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionState,
    type ConversationTarget,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";

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
    | ({ readonly kind: "connection-failed"; readonly message: string } & BotView)
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
        case "connection-failed":
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
    readonly connectionFailed: ChatEntryNotice;
    readonly pairing: ChatEntryNotice;
}

export interface BotChatHomeStore {
    readonly view: BotChatHomeView;
    readonly connectionStatus: BotConnectionStatus;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    readonly revision: number;
    readonly directoryRevision: number;
    readonly draft: string;
    readonly draftSettings: ChatDraftConfiguration | null;
    readonly optimisticTitles: ReadonlyMap<string, string>;
    /** Entry notices that surface a dialog once when the workflow resolves. */
    readonly notices: ChatEntryNotices;
    readonly dismissNotice: (notice: "connection-failed" | "pairing") => void;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly newConversation: () => void;
    readonly openManaged: (isExternal: boolean, id: string) => void;
    readonly retry: () => void;
    readonly forkInstead: () => void;
    readonly setDraft: (draft: string) => void;
    readonly setDraftSettings: (settings: ChatDraftConfiguration | null) => void;
    readonly updateConversationTitle: (sessionId: string, title: string) => void;
    /** Clears the queued first message once the pane has sent it. */
    readonly initialMessageDelivered: (conversationId: string) => void;
    readonly createConversation: (
        draft: string,
        attachments: readonly ComposerAttachment[],
        signal: AbortSignal,
    ) => Promise<boolean>;
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
        readonly url: string;
        readonly createId: () => string;
        readonly navigation: BotChatNavigation;
    },
) => {
    const botId = options.botId;
    const conversations = createConversationSessionStore(requests);
    const selection = initialSelection(options.url, options.createId);
    return createStore<BotChatHomeStore>()((set, get) => ({
        view: { kind: "loading" },
        connectionStatus: { kind: "connecting", label: "Connecting" },
        selection,
        creation: { kind: "draft" },
        revision: 0,
        directoryRevision: 0,
        draft: "",
        draftSettings: null,
        optimisticTitles: new Map(),
        notices: { connectionFailed: { kind: "hidden" }, pairing: { kind: "hidden" } },
        dismissNotice: (notice) =>
            set((current) => ({
                notices:
                    notice === "connection-failed"
                        ? { ...current.notices, connectionFailed: { kind: "hidden" } }
                        : { ...current.notices, pairing: { kind: "hidden" } },
            })),
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
                    const changedReason = setupReason(changedConfiguration);
                    set((current) =>
                        current.selection.kind === "draft"
                            ? {
                                  connectionStatus: runtimeConnectionStatus(changedConfiguration),
                                  view:
                                      changedReason === null
                                          ? { kind: "active", botId }
                                          : { kind: "setup", botId, reason: changedReason },
                              }
                            : { connectionStatus: runtimeConnectionStatus(changedConfiguration) },
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
                    return;
                }
                const configuration = await requests.runtimeConfiguration(botId, signal);
                signal.throwIfAborted();
                set({ connectionStatus: runtimeConnectionStatus(configuration) });
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
                await watchRuntimeConfigurationChanges();
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                if (cause instanceof DOMException && cause.name === "TimeoutError") {
                    set((current) => ({ revision: current.revision + 1 }));
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
                            ? { connectionStatus: { kind: "disconnected" as const, label: "Disconnected" as const } }
                            : {}),
                    });
                    return;
                }
                if (opened && runtimeFailure) {
                    set({
                        connectionStatus: { kind: "disconnected", label: "Disconnected" },
                        view: { kind: "runtime-disconnected", botId, message },
                    });
                    try {
                        await requests.waitForRuntimeConfigurationChange(botId, signal);
                        signal.throwIfAborted();
                        set((current) => ({ revision: current.revision + 1 }));
                    } catch (watchCause) {
                        if (signal.aborted) {
                            return;
                        }
                        if (watchCause instanceof DOMException && watchCause.name === "TimeoutError") {
                            set((current) => ({ revision: current.revision + 1 }));
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
                    view: opened ? { kind: "connection-failed", botId, message } : { kind: "failed", message },
                    ...(opened && current.notices.connectionFailed.kind === "hidden"
                        ? { notices: { ...current.notices, connectionFailed: { kind: "visible" as const } } }
                        : {}),
                }));
            }
        },
        newConversation: () => {
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
                revision: state.view.kind === "active" ? state.revision : state.revision + 1,
            }));
        },
        openManaged: (isExternal, id) => {
            options.navigation.showManaged(isExternal, id);
            set((current) => ({
                selection: transitionConversationSelection(current.selection, {
                    kind: "target-selected",
                    target: { kind: "session", sessionId: id },
                }),
                creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                draftSettings: null,
                revision: current.revision + 1,
            }));
        },
        retry: () =>
            set((current) => ({
                selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                revision: current.revision + 1,
            })),
        forkInstead: () => {
            const current = get().selection;
            if (current.kind === "failed" && current.target.kind === "continue") {
                const target: ConversationTarget = { ...current.target, action: "fork" };
                options.navigation.showForkInstead();
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, { kind: "target-selected", target }),
                    revision: state.revision + 1,
                }));
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
        updateConversationTitle: (sessionId, title) =>
            set((state) => ({
                optimisticTitles: new Map(state.optimisticTitles).set(sessionId, title),
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
        createConversation: async (draft, attachments, signal) => {
            const current = get();
            if (
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
                const session = requests.conversationSession(access, { kind: "idle" }, settings.workspaceLabel, title);
                set((state) => ({
                    creation: transitionConversationCreation(state.creation, {
                        commandId,
                        conversationId: access.conversationId,
                        kind: "draft-message-sent",
                        session,
                    }),
                }));
                const sent = get().creation;
                if (sent.kind !== "draft-message-sent") {
                    return false;
                }
                options.navigation.showManaged(false, sent.conversationId);
                set((state) => ({
                    draft: "",
                    selection: transitionConversationSelection(state.selection, {
                        kind: "conversation-created",
                        conversationId: sent.conversationId,
                        session: sent.session,
                    }),
                    directoryRevision: state.directoryRevision + 1,
                    optimisticTitles: new Map(state.optimisticTitles).set(sent.conversationId, sent.message.summary),
                }));
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
    }));
};
