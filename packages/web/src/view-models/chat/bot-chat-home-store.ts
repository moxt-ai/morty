import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { createStore } from "zustand/vanilla";
import type { SelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import type {
    BotChatApi,
    ChatAccess,
    ChatDraftConfiguration,
    ChatWorkspace,
} from "../../services/chat/bot-chat-api.ts";
import { centralLocalStorage, newConversationDraftEntry } from "../../services/local-storage/central-local-storage.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import { type ConversationCreationState, transitionConversationCreation } from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionState,
    type ConversationTarget,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";

export type SetupReason = "unconfigured" | "agent-missing" | "runtime-offline" | "agent-required";

type ActiveView = { readonly kind: "active"; readonly bot: ManagedBot };
export type BotChatHomeView =
    | { readonly kind: "loading" }
    | { readonly kind: "connecting"; readonly bot: ManagedBot }
    | ActiveView
    | { readonly kind: "setup"; readonly bot: ManagedBot; readonly reason: SetupReason }
    | { readonly kind: "runtime-disconnected"; readonly bot: ManagedBot; readonly message: string }
    | { readonly kind: "connection-failed"; readonly bot: ManagedBot; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

export type BotConnectionStatus =
    | { readonly kind: "connecting"; readonly label: "Connecting" }
    | { readonly kind: "connected"; readonly label: "Connected" }
    | { readonly kind: "disconnected"; readonly label: "Disconnected" };
export type BotOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "removing" }
    | { readonly kind: "failed"; readonly message: string };

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
                title: "Your Machine is disconnected",
                description: "Start your local Runtime to reconnect this Machine and use its Sessions.",
            };
        case "setup":
            return view.reason === "unconfigured"
                ? { kind: "hidden" }
                : {
                      kind: "visible",
                      title: "Your Machine is disconnected",
                      description: "Start your local Runtime to reconnect this Machine and use its Sessions.",
                  };
        case "loading":
        case "connecting":
        case "failed":
            return { kind: "hidden" };
    }
}

function runtimeConnectionStatus(workspace: ChatWorkspace): BotConnectionStatus {
    return workspace.runtime.online
        ? { kind: "connected", label: "Connected" }
        : { kind: "disconnected", label: "Disconnected" };
}

function isRuntimeConnectionFailure(cause: unknown): boolean {
    return cause instanceof CloudApiError && isRuntimeConnectionCode(cause.code);
}

function isRuntimeConnectionCode(code: string | null): boolean {
    return code !== null && ["connection_closed", "runtime_offline"].includes(code.toLowerCase());
}

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (isExternal: boolean, id: string) => void;
    readonly showContinuedSession: (sessionId: string) => void;
    readonly showForkInstead: () => void;
}

export interface BotChatHomeStore {
    readonly bots: readonly ManagedBot[];
    readonly botOperation: BotOperation;
    readonly view: BotChatHomeView;
    readonly connectionStatus: BotConnectionStatus;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    readonly revision: number;
    readonly directoryRevision: number;
    readonly draft: string;
    readonly draftSettings: ChatDraftConfiguration | null;
    readonly optimisticTitles: ReadonlyMap<string, string>;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly selectBot: (botId: string) => void;
    readonly createBot: (displayName: string, signal: AbortSignal) => Promise<boolean>;
    readonly removeBot: (signal: AbortSignal) => Promise<boolean>;
    readonly resetBotOperation: () => void;
    readonly newConversation: () => void;
    readonly openManaged: (isExternal: boolean, id: string) => void;
    readonly retry: () => void;
    readonly forkInstead: () => void;
    readonly setDraft: (draft: string) => void;
    readonly setDraftSettings: (settings: ChatDraftConfiguration | null) => void;
    readonly updateConversationTitle: (sessionId: string, title: string) => void;
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

function setupReason(workspace: ChatWorkspace): SetupReason | null {
    if (workspace.runtime.agents.length === 0) {
        return "agent-missing";
    }
    return workspace.runtime.online ? null : "runtime-offline";
}

export function setupDescription(reason: SetupReason): string {
    switch (reason) {
        case "unconfigured":
            return "Your workspace is loaded. Paste this instruction into your local agent to connect it to this workspace.";
        case "agent-missing":
            return "Your workspace is loaded, but its connected Runtime no longer reports any agents. Start the paired Runtime, or use the instruction below to pair it again.";
        case "runtime-offline":
            return "Your workspace is loaded, but its connected Runtime is offline. Start the paired Runtime and check its internet connection, or use the instruction below to pair it again.";
        case "agent-required":
            return "Your workspace is loaded, but the server could not connect Chat to an available agent. Check that your local agent is running, or use the instruction below to pair it again.";
    }
}

export const createBotChatHomeStore = (
    requests: Pick<
        BotChatApi,
        | "access"
        | "conversationSession"
        | "continueNativeSession"
        | "createConversation"
        | "createBot"
        | "deleteBot"
        | "listBots"
        | "managedSession"
        | "readBot"
        | "waitForSetupChange"
        | "waitForWorkspaceChange"
        | "workspace"
        | "workspaceDirectory"
    >,
    options: {
        readonly url: string;
        readonly createId: () => string;
        readonly navigation: BotChatNavigation;
        readonly selectedBotPreference: SelectedBotPreference;
    },
) => {
    const conversations = createConversationSessionStore(requests);
    const selection = initialSelection(options.url, options.createId);
    return createStore<BotChatHomeStore>()((set, get) => ({
        bots: [],
        botOperation: { kind: "idle" },
        view: { kind: "loading" },
        connectionStatus: { kind: "connecting", label: "Connecting" },
        selection,
        creation: { kind: "draft" },
        revision: 0,
        directoryRevision: 0,
        draft: "",
        draftSettings: null,
        optimisticTitles: new Map(),
        load: async (signal) => {
            set((current) => ({ view: "bot" in current.view ? current.view : { kind: "loading" } }));
            let openedBot: ManagedBot | null = null;
            const watchWorkspaceChanges = async (bot: ManagedBot): Promise<void> => {
                while (true) {
                    try {
                        await requests.waitForWorkspaceChange(bot.botId, signal);
                    } catch (cause) {
                        if (cause instanceof DOMException && cause.name === "TimeoutError") {
                            continue;
                        }
                        throw cause;
                    }
                    signal.throwIfAborted();
                    const changedWorkspace = await requests.workspace(bot.botId, signal);
                    signal.throwIfAborted();
                    const changedReason = setupReason(changedWorkspace);
                    set((current) =>
                        current.selection.kind === "draft"
                            ? {
                                  connectionStatus: runtimeConnectionStatus(changedWorkspace),
                                  view:
                                      changedReason === null
                                          ? { kind: "active", bot }
                                          : { kind: "setup", bot, reason: changedReason },
                              }
                            : { connectionStatus: runtimeConnectionStatus(changedWorkspace) },
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
                    const bot = current.view.bot;
                    const target = current.selection.target;
                    openedBot = bot;
                    const session = await requests.managedSession(bot.botId, target.sessionId, signal);
                    signal.throwIfAborted();
                    set((state) => ({
                        selection: transitionConversationSelection(state.selection, {
                            kind: "session-loaded",
                            session,
                            target,
                        }),
                    }));
                    await watchWorkspaceChanges(bot);
                    return;
                }
                const bots = await requests.listBots(signal);
                const preferredBotId = options.selectedBotPreference.read();
                const bot = bots.find((candidate) => candidate.botId === preferredBotId) ?? bots[0];
                if (bot === undefined) {
                    throw new Error("Your Machine is unavailable.");
                }
                options.selectedBotPreference.write(bot.botId);
                openedBot = bot;
                set({
                    bots,
                    ...(get().selection.kind === "draft"
                        ? { draft: centralLocalStorage.read(newConversationDraftEntry(bot.botId)) ?? "" }
                        : {}),
                });
                if (get().view.kind === "loading") {
                    set({ view: { kind: "connecting", bot } });
                }
                const detail = await requests.readBot(bot.botId, signal);
                signal.throwIfAborted();
                if (!detail.configured) {
                    set((current) => ({
                        connectionStatus: { kind: "disconnected", label: "Disconnected" },
                        selection:
                            current.selection.kind === "loading"
                                ? transitionConversationSelection(current.selection, {
                                      kind: "session-load-failed",
                                      message: "Connect your local agent to load this Session.",
                                      target: current.selection.target,
                                  })
                                : current.selection,
                        view: { kind: "setup", bot, reason: "unconfigured" },
                    }));
                    await requests.waitForSetupChange(bot.botId, signal);
                    signal.throwIfAborted();
                    set((current) => ({
                        selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                        revision: current.revision + 1,
                    }));
                    return;
                }
                const workspace = await requests.workspace(bot.botId, signal);
                signal.throwIfAborted();
                set({ connectionStatus: runtimeConnectionStatus(workspace) });
                const currentSelection = get().selection;
                const currentTarget = currentSelection.kind === "draft" ? null : currentSelection.target;
                if (currentTarget?.kind === "continue") {
                    const session = await requests.continueNativeSession(
                        bot.botId,
                        currentTarget.harness,
                        currentTarget.sessionId,
                        currentTarget.action,
                        signal,
                    );
                    signal.throwIfAborted();
                    options.navigation.showContinuedSession(session.result.ready.sessionId);
                    set({
                        view: { kind: "active", bot },
                        selection: transitionConversationSelection(get().selection, {
                            kind: "continued-session-loaded",
                            session,
                            target: currentTarget,
                        }),
                    });
                    await watchWorkspaceChanges(bot);
                    return;
                }
                if (currentTarget?.kind === "session") {
                    const session = await requests.managedSession(bot.botId, currentTarget.sessionId, signal);
                    signal.throwIfAborted();
                    set((current) => ({
                        view: { kind: "active", bot },
                        selection: transitionConversationSelection(current.selection, {
                            kind: "session-loaded",
                            session,
                            target: currentTarget,
                        }),
                    }));
                    await watchWorkspaceChanges(bot);
                    return;
                }
                const reason = currentTarget === null ? setupReason(workspace) : null;
                if (reason !== null) {
                    set({ view: { kind: "setup", bot, reason } });
                    await watchWorkspaceChanges(bot);
                    return;
                }
                if (currentTarget === null) {
                    set({ view: { kind: "active", bot } });
                    await watchWorkspaceChanges(bot);
                    return;
                }
                await conversations.getState().open(bot.botId, currentTarget.conversationId, signal);
                const opened = conversations.getState().state;
                if (opened.kind !== "ready") {
                    if (opened.kind === "failed" && opened.code !== null) {
                        throw new CloudApiError(opened.code, opened.message);
                    }
                    throw new Error(opened.kind === "failed" ? opened.message : "The Session could not be opened.");
                }
                set((current) => ({
                    view: { kind: "active", bot },
                    selection: transitionConversationSelection(current.selection, {
                        kind: "session-loaded",
                        session: opened.session,
                        target: currentTarget,
                    }),
                }));
                await watchWorkspaceChanges(bot);
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
                    if (openedBot === null) {
                        set({
                            selection: failedSelection,
                            view: { kind: "failed", message: "Your Machine is unavailable." },
                        });
                        return;
                    }
                    set({
                        selection: failedSelection,
                        view: { kind: "setup", bot: openedBot, reason: "agent-required" },
                    });
                    await requests.waitForWorkspaceChange(openedBot.botId, signal);
                    signal.throwIfAborted();
                    set((current) => ({
                        selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                        revision: current.revision + 1,
                    }));
                    return;
                }
                const message = cause instanceof Error ? cause.message : "Chat is unavailable.";
                const runtimeFailure = isRuntimeConnectionFailure(cause);
                const failedSelection = get().selection;
                if (failedSelection.kind === "loading") {
                    set({
                        selection: transitionConversationSelection(failedSelection, {
                            kind: "session-load-failed",
                            message,
                            target: failedSelection.target,
                        }),
                        view:
                            openedBot === null
                                ? { kind: "failed", message }
                                : runtimeFailure
                                  ? { kind: "runtime-disconnected", bot: openedBot, message }
                                  : { kind: "active", bot: openedBot },
                        ...(runtimeFailure
                            ? { connectionStatus: { kind: "disconnected" as const, label: "Disconnected" as const } }
                            : {}),
                    });
                    return;
                }
                if (openedBot !== null && runtimeFailure) {
                    set({
                        connectionStatus: { kind: "disconnected", label: "Disconnected" },
                        view: { kind: "runtime-disconnected", bot: openedBot, message },
                    });
                    try {
                        await requests.waitForWorkspaceChange(openedBot.botId, signal);
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
                    view:
                        openedBot === null
                            ? { kind: "failed", message }
                            : { kind: "connection-failed", bot: openedBot, message },
                }));
            }
        },
        selectBot: (botId) => {
            const current = get();
            const selected = current.bots.find((bot) => bot.botId === botId);
            const activeBot = "bot" in current.view ? current.view.bot : null;
            if (selected === undefined || selected.botId === activeBot?.botId) {
                return;
            }
            options.selectedBotPreference.write(selected.botId);
            options.navigation.showDraft();
            set((state) => ({
                botOperation: { kind: "idle" },
                connectionStatus: { kind: "connecting", label: "Connecting" },
                creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                draft: centralLocalStorage.read(newConversationDraftEntry(selected.botId)) ?? "",
                draftSettings: null,
                optimisticTitles: new Map(),
                revision: state.revision + 1,
                selection: transitionConversationSelection(state.selection, {
                    kind: "draft-selected",
                    key: options.createId(),
                }),
                view: { kind: "connecting", bot: selected },
            }));
        },
        createBot: async (displayName, signal) => {
            const name = displayName.trim();
            if (name.length === 0 || name.length > 80) {
                set({ botOperation: { kind: "failed", message: "Enter a Machine name between 1 and 80 characters." } });
                return false;
            }
            set({ botOperation: { kind: "creating" } });
            try {
                const bot = await requests.createBot(name, signal);
                signal.throwIfAborted();
                options.selectedBotPreference.write(bot.botId);
                options.navigation.showDraft();
                set((state) => ({
                    bots: [...state.bots, bot],
                    botOperation: { kind: "idle" },
                    connectionStatus: { kind: "disconnected", label: "Disconnected" },
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draft: "",
                    draftSettings: null,
                    optimisticTitles: new Map(),
                    revision: state.revision + 1,
                    selection: transitionConversationSelection(state.selection, {
                        kind: "draft-selected",
                        key: options.createId(),
                    }),
                    view: { kind: "setup", bot, reason: "unconfigured" },
                }));
                return true;
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        botOperation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The Machine could not be created.",
                        },
                    });
                }
                return false;
            }
        },
        removeBot: async (signal) => {
            const current = get();
            const activeBot = "bot" in current.view ? current.view.bot : null;
            if (activeBot === null || current.bots.length < 2) {
                return false;
            }
            set({ botOperation: { kind: "removing" } });
            try {
                await requests.deleteBot(activeBot.botId, signal);
                signal.throwIfAborted();
                const bots = get().bots.filter((bot) => bot.botId !== activeBot.botId);
                const selected = bots[0];
                if (selected === undefined) {
                    throw new Error("Keep at least one Machine in your workspace.");
                }
                options.selectedBotPreference.write(selected.botId);
                options.navigation.showDraft();
                set((state) => ({
                    bots,
                    botOperation: { kind: "idle" },
                    connectionStatus: { kind: "connecting", label: "Connecting" },
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draft: centralLocalStorage.read(newConversationDraftEntry(selected.botId)) ?? "",
                    draftSettings: null,
                    optimisticTitles: new Map(),
                    revision: state.revision + 1,
                    selection: transitionConversationSelection(state.selection, {
                        kind: "draft-selected",
                        key: options.createId(),
                    }),
                    view: { kind: "connecting", bot: selected },
                }));
                return true;
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        botOperation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The Machine could not be removed.",
                        },
                    });
                }
                return false;
            }
        },
        resetBotOperation: () => set({ botOperation: { kind: "idle" } }),
        newConversation: () => {
            const current = get();
            const activeBot = "bot" in current.view ? current.view.bot : null;
            if (activeBot !== null) {
                centralLocalStorage.remove(newConversationDraftEntry(activeBot.botId));
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
            const activeBot = "bot" in current.view ? current.view.bot : null;
            if (activeBot !== null) {
                const entry = newConversationDraftEntry(activeBot.botId);
                if (draft === "") {
                    centralLocalStorage.remove(entry);
                } else {
                    centralLocalStorage.write(entry, draft);
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
        createConversation: async (draft, attachments, signal) => {
            const current = get();
            if (
                current.view.kind !== "active" ||
                current.selection.kind !== "draft" ||
                current.draftSettings === null
            ) {
                return false;
            }
            const botId = current.view.bot.botId;
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
                            error: cause instanceof Error ? cause.message : "The Session could not be created.",
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
                centralLocalStorage.remove(newConversationDraftEntry(botId));
                return true;
            } catch (cause) {
                signal.throwIfAborted();
                set((state) => ({
                    creation: transitionConversationCreation(state.creation, {
                        commandId,
                        error: cause instanceof Error ? cause.message : "The message could not be sent.",
                        kind: "draft-message-send-failed",
                    }),
                }));
                return false;
            }
        },
    }));
};
