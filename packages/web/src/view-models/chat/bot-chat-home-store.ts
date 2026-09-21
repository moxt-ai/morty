import { createStore } from "zustand/vanilla";
import type { SelectedBotPreference } from "../../services/bots/selected-bot-preference.ts";
import type {
    BotChatApi,
    ChatAccess,
    ChatDraftConfiguration,
    ChatWorkspace,
} from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import { type ConversationCreationState, transitionConversationCreation } from "./conversation-creation-machine.ts";
import { createConversationSessionStore } from "./conversation-session-store.ts";
import type { OpenMobiusSession } from "./open-session.ts";

export type SetupReason =
    | "unconfigured"
    | "inactive"
    | "no-selection"
    | "agent-missing"
    | "agent-offline"
    | "agent-required";

type Target =
    | { readonly kind: "draft"; readonly key: string }
    | { readonly kind: "conversation-access"; readonly conversationId: string }
    | { readonly kind: "session-access"; readonly sessionId: string }
    | {
          readonly kind: "continue";
          readonly action: "fork" | "import";
          readonly harness: string;
          readonly sessionId: string;
      };

type ActiveView = { readonly kind: "draft"; readonly bot: ManagedBot };
type SessionLoading = { readonly kind: "session-loading"; readonly bot: ManagedBot };
export type BotChatHomeView =
    | { readonly kind: "loading" }
    | { readonly kind: "connecting"; readonly bot: ManagedBot }
    | SessionLoading
    | { readonly kind: "switching"; readonly view: ActiveView }
    | ActiveView
    | { readonly kind: "setup"; readonly bot: ManagedBot; readonly reason: SetupReason }
    | { readonly kind: "runtime-disconnected"; readonly bot: ManagedBot; readonly message: string }
    | { readonly kind: "connection-failed"; readonly bot: ManagedBot; readonly message: string }
    | { readonly kind: "session-failed"; readonly bot: ManagedBot; readonly message: string }
    | { readonly kind: "failed"; readonly message: string };

export type BotConnectionStatus =
    | { readonly kind: "connecting"; readonly label: "Connecting" }
    | { readonly kind: "connected"; readonly label: "Connected" }
    | { readonly kind: "disconnected"; readonly label: "Disconnected" };
export type SessionConnectionKind = "loading" | "ready" | "failed";
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
        case "draft":
        case "runtime-disconnected":
        case "connection-failed":
        case "session-failed":
            return {
                kind: "visible",
                title: "Your Bot is disconnected",
                description: "Start your local Runtime to reconnect this Bot and use its Sessions.",
            };
        case "setup":
            return view.reason === "unconfigured"
                ? { kind: "hidden" }
                : {
                      kind: "visible",
                      title: "Your Bot is disconnected",
                      description: "Start your local Runtime to reconnect this Bot and use its Sessions.",
                  };
        case "loading":
        case "connecting":
        case "session-loading":
        case "switching":
        case "failed":
            return { kind: "hidden" };
    }
}

function runtimeConnectionStatus(workspace: ChatWorkspace): BotConnectionStatus {
    if (workspace.status !== "active") {
        return { kind: "disconnected", label: "Disconnected" };
    }
    const selected = workspace.selected;
    const agent =
        selected === null
            ? undefined
            : workspace.agents.find(
                  (candidate) => candidate.runtimeId === selected.runtimeId && candidate.agentRef === selected.agentRef,
              );
    return agent?.online === true
        ? { kind: "connected", label: "Connected" }
        : { kind: "disconnected", label: "Disconnected" };
}

function isRuntimeConnectionFailure(cause: unknown): boolean {
    return cause instanceof CloudApiError && isRuntimeConnectionCode(cause.code);
}

function isRuntimeConnectionCode(code: string | null): boolean {
    return code !== null && ["connection_closed", "runtime_offline"].includes(code.toLowerCase());
}

function sessionConnectionStatus(connection: SessionConnectionKind): BotConnectionStatus {
    switch (connection) {
        case "loading":
            return { kind: "connecting", label: "Connecting" };
        case "ready":
            return { kind: "connected", label: "Connected" };
        case "failed":
            return { kind: "disconnected", label: "Disconnected" };
    }
}

type SessionView =
    | { readonly kind: "conversation-access" }
    | { readonly kind: "session-access"; readonly session: OpenMobiusSession };

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (kind: "conversation" | "fork" | "import", id: string) => void;
    readonly showContinuedSession: (sessionId: string) => void;
    readonly showForkInstead: () => void;
}

export interface BotChatHomeStore {
    readonly bots: readonly ManagedBot[];
    readonly botOperation: BotOperation;
    readonly view: BotChatHomeView;
    readonly connectionStatus: BotConnectionStatus;
    readonly target: Target;
    readonly sessionView: SessionView;
    readonly creation: ConversationCreationState;
    readonly revision: number;
    readonly draftSettings: ChatDraftConfiguration | null;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly selectBot: (botId: string) => void;
    readonly createBot: (displayName: string, signal: AbortSignal) => Promise<boolean>;
    readonly removeBot: (signal: AbortSignal) => Promise<boolean>;
    readonly resetBotOperation: () => void;
    readonly newConversation: () => void;
    readonly openManaged: (kind: "conversation" | "fork" | "import", id: string) => void;
    readonly retry: () => void;
    readonly setSessionConnectionStatus: (sessionId: string, connection: SessionConnectionKind) => void;
    readonly forkInstead: () => void;
    readonly setDraftSettings: (settings: ChatDraftConfiguration | null) => void;
    readonly createConversation: (
        draft: string,
        attachments: readonly ComposerAttachment[],
        signal: AbortSignal,
    ) => Promise<boolean>;
}

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function initialTarget(urlValue: string, createId: () => string): Target {
    const url = new URL(urlValue);
    const sessionId = url.searchParams.get("sessionId");
    const harness = url.searchParams.get("harness");
    const requestedAction = url.searchParams.get("nativeSessionAction");
    if (sessionId !== null && identifierPattern.test(sessionId)) {
        if (harness !== null && identifierPattern.test(harness)) {
            return requestedAction === null || requestedAction === "fork" || requestedAction === "import"
                ? { kind: "continue", action: requestedAction ?? "fork", harness, sessionId }
                : { kind: "draft", key: createId() };
        }
        return { kind: "session-access", sessionId };
    }
    const conversationId = url.searchParams.get("conversationId");
    return conversationId !== null && identifierPattern.test(conversationId)
        ? { kind: "conversation-access", conversationId }
        : { kind: "draft", key: createId() };
}

function setupReason(workspace: ChatWorkspace): SetupReason | null {
    if (workspace.status !== "active") {
        return workspace.status === "draft" ? "unconfigured" : "inactive";
    }
    if (workspace.selected === null) {
        return "no-selection";
    }
    const selected = workspace.selected;
    const agent = workspace.agents.find(
        (candidate) => candidate.runtimeId === selected.runtimeId && candidate.agentRef === selected.agentRef,
    );
    if (agent === undefined) {
        return "agent-missing";
    }
    return agent.online ? null : "agent-offline";
}

export function setupDescription(reason: SetupReason): string {
    switch (reason) {
        case "unconfigured":
            return "Your workspace is loaded. Paste this instruction into your local agent to connect it to this workspace.";
        case "inactive":
            return "Your workspace is loaded, but this Bot is not active, so Chat cannot reconnect. Use the instruction below to connect your local agent and activate Chat.";
        case "no-selection":
            return "Your workspace is loaded, but no agent is selected for this Bot. Use the instruction below to connect an agent to this workspace.";
        case "agent-missing":
            return "Your workspace is loaded, but the previously selected agent is no longer available in its agent list. Start the previously paired local agent, or use the instruction below to pair an agent again.";
        case "agent-offline":
            return "Your workspace is loaded, but your selected local agent is offline. Start the previously paired agent and check its internet connection. If you need to pair it again, use the instruction below.";
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
        | "submitTurn"
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
    const target = initialTarget(options.url, options.createId);
    return createStore<BotChatHomeStore>()((set, get) => ({
        bots: [],
        botOperation: { kind: "idle" },
        view: { kind: "loading" },
        connectionStatus: { kind: "connecting", label: "Connecting" },
        target,
        sessionView: { kind: "conversation-access" },
        creation: { kind: "draft" },
        revision: 0,
        draftSettings: null,
        load: async (signal) => {
            set((current) => ({
                sessionView: { kind: "conversation-access" },
                view:
                    current.view.kind === "draft"
                        ? current.target.kind === "draft"
                            ? current.view
                            : { kind: "switching", view: current.view }
                        : current.view.kind === "switching"
                          ? current.view
                          : { kind: "loading" },
            }));
            let openedBot: ManagedBot | null = null;
            try {
                const bots = await requests.listBots(signal);
                const preferredBotId = options.selectedBotPreference.read();
                const bot = bots.find((candidate) => candidate.botId === preferredBotId) ?? bots[0];
                if (bot === undefined) {
                    throw new Error("Your Bot is unavailable.");
                }
                options.selectedBotPreference.write(bot.botId);
                openedBot = bot;
                set({ bots });
                if (get().view.kind === "loading") {
                    set({ view: { kind: "connecting", bot } });
                }
                const workspace = await requests.workspace(bot.botId, signal);
                signal.throwIfAborted();
                set({ connectionStatus: runtimeConnectionStatus(workspace) });
                const currentTarget = get().target;
                const reloadAfterWorkspaceChange = async (): Promise<void> => {
                    await requests.waitForWorkspaceChange(bot.botId, signal);
                    signal.throwIfAborted();
                    const changedWorkspace = await requests.workspace(bot.botId, signal);
                    signal.throwIfAborted();
                    set((current) => ({
                        connectionStatus: runtimeConnectionStatus(changedWorkspace),
                        revision: current.revision + 1,
                    }));
                };
                if (currentTarget.kind === "continue") {
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
                        target: { kind: "session-access", sessionId: session.result.ready.sessionId },
                        view: { kind: "draft", bot },
                        sessionView: { kind: "session-access", session },
                    });
                    await reloadAfterWorkspaceChange();
                    return;
                }
                if (currentTarget.kind === "session-access") {
                    const session = await requests.managedSession(bot.botId, currentTarget.sessionId, signal);
                    signal.throwIfAborted();
                    set({ view: { kind: "draft", bot }, sessionView: { kind: "session-access", session } });
                    await reloadAfterWorkspaceChange();
                    return;
                }
                const reason = currentTarget.kind === "draft" ? setupReason(workspace) : null;
                if (reason !== null) {
                    set({ view: { kind: "setup", bot, reason } });
                    await reloadAfterWorkspaceChange();
                    return;
                }
                if (currentTarget.kind === "draft") {
                    set({ view: { kind: "draft", bot } });
                    await reloadAfterWorkspaceChange();
                    return;
                }
                set({ view: { kind: "session-loading", bot } });
                await conversations.getState().open(bot.botId, currentTarget.conversationId, signal);
                const opened = conversations.getState().state;
                if (opened.kind !== "ready") {
                    if (opened.kind === "failed" && opened.code !== null) {
                        throw new CloudApiError(opened.code, opened.message);
                    }
                    throw new Error(opened.kind === "failed" ? opened.message : "The Session could not be opened.");
                }
                set({ view: { kind: "draft", bot }, sessionView: { kind: "session-access", session: opened.session } });
                await reloadAfterWorkspaceChange();
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                if (cause instanceof DOMException && cause.name === "TimeoutError") {
                    set((current) => ({ revision: current.revision + 1 }));
                    return;
                }
                if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                    if (openedBot === null) {
                        set({ view: { kind: "failed", message: "Your Bot is unavailable." } });
                        return;
                    }
                    set({ view: { kind: "setup", bot: openedBot, reason: "agent-required" } });
                    await requests.waitForWorkspaceChange(openedBot.botId, signal);
                    signal.throwIfAborted();
                    set((current) => ({ revision: current.revision + 1 }));
                    return;
                }
                const message = cause instanceof Error ? cause.message : "Chat is unavailable.";
                const runtimeFailure = isRuntimeConnectionFailure(cause);
                if (openedBot !== null && get().target.kind === "conversation-access" && !runtimeFailure) {
                    set({ view: { kind: "session-failed", bot: openedBot, message } });
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
            const activeBot =
                current.view.kind === "switching"
                    ? current.view.view.bot
                    : "bot" in current.view
                      ? current.view.bot
                      : null;
            if (selected === undefined || selected.botId === activeBot?.botId) {
                return;
            }
            options.selectedBotPreference.write(selected.botId);
            options.navigation.showDraft();
            set((state) => ({
                botOperation: { kind: "idle" },
                connectionStatus: { kind: "connecting", label: "Connecting" },
                creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                draftSettings: null,
                revision: state.revision + 1,
                sessionView: { kind: "conversation-access" },
                target: { kind: "draft", key: options.createId() },
                view: { kind: "connecting", bot: selected },
            }));
        },
        createBot: async (displayName, signal) => {
            const name = displayName.trim();
            if (name.length === 0 || name.length > 80) {
                set({ botOperation: { kind: "failed", message: "Enter a Bot name between 1 and 80 characters." } });
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
                    draftSettings: null,
                    revision: state.revision + 1,
                    sessionView: { kind: "conversation-access" },
                    target: { kind: "draft", key: options.createId() },
                    view: { kind: "setup", bot, reason: "unconfigured" },
                }));
                return true;
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        botOperation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The Bot could not be created.",
                        },
                    });
                }
                return false;
            }
        },
        removeBot: async (signal) => {
            const current = get();
            const activeBot =
                current.view.kind === "switching"
                    ? current.view.view.bot
                    : "bot" in current.view
                      ? current.view.bot
                      : null;
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
                    throw new Error("Keep at least one Bot in your workspace.");
                }
                options.selectedBotPreference.write(selected.botId);
                options.navigation.showDraft();
                set((state) => ({
                    bots,
                    botOperation: { kind: "idle" },
                    connectionStatus: { kind: "connecting", label: "Connecting" },
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draftSettings: null,
                    revision: state.revision + 1,
                    sessionView: { kind: "conversation-access" },
                    target: { kind: "draft", key: options.createId() },
                    view: { kind: "connecting", bot: selected },
                }));
                return true;
            } catch (cause) {
                if (!signal.aborted) {
                    set({
                        botOperation: {
                            kind: "failed",
                            message: cause instanceof Error ? cause.message : "The Bot could not be removed.",
                        },
                    });
                }
                return false;
            }
        },
        resetBotOperation: () => set({ botOperation: { kind: "idle" } }),
        newConversation: () => {
            options.navigation.showDraft();
            set((current) => ({
                target: { kind: "draft", key: options.createId() },
                sessionView: { kind: "conversation-access" },
                creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                draftSettings: null,
                revision: current.revision + 1,
            }));
        },
        openManaged: (kind, id) => {
            options.navigation.showManaged(kind, id);
            set((current) => ({
                target:
                    kind === "conversation"
                        ? { kind: "conversation-access", conversationId: id }
                        : { kind: "session-access", sessionId: id },
                sessionView: { kind: "conversation-access" },
                creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                draftSettings: null,
                revision: current.revision + 1,
            }));
        },
        retry: () => set((current) => ({ revision: current.revision + 1 })),
        setSessionConnectionStatus: (sessionId, connection) =>
            set((current) =>
                current.sessionView.kind === "session-access" &&
                current.sessionView.session.result.ready.sessionId === sessionId
                    ? { connectionStatus: sessionConnectionStatus(connection) }
                    : current,
            ),
        forkInstead: () => {
            const current = get().target;
            if (current.kind === "continue") {
                options.navigation.showForkInstead();
                set((state) => ({ target: { ...current, action: "fork" }, revision: state.revision + 1 }));
            }
        },
        setDraftSettings: (draftSettings) => set({ draftSettings }),
        createConversation: async (draft, attachments, signal) => {
            const current = get();
            if (current.view.kind !== "draft" || current.target.kind !== "draft" || current.draftSettings === null) {
                return false;
            }
            const botId = current.view.bot.botId;
            const commandId = current.target.key;
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
                const accepted = await requests.submitTurn(
                    botId,
                    access.sessionId,
                    {
                        additionalDirectoryIds: [],
                        artifactIds: [],
                        content: sending.message.content,
                        idempotencyKey: sending.message.commandId,
                        images: sending.message.attachments.flatMap((attachment) =>
                            attachment.kind === "image" ? [attachment.image] : [],
                        ),
                        resources: sending.message.attachments.flatMap((attachment) =>
                            attachment.kind === "resource" ? [attachment.resource] : [],
                        ),
                        sessionConfigurations: settings.configurations,
                    },
                    signal,
                );
                signal.throwIfAborted();
                const session = requests.conversationSession(
                    access,
                    { kind: "running", commandId: sending.message.commandId, turnId: accepted.turnId },
                    settings.workspaceLabel,
                );
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
                options.navigation.showManaged("conversation", sent.conversationId);
                set({
                    target: { kind: "conversation-access", conversationId: sent.conversationId },
                    sessionView: { kind: "session-access", session: sent.session },
                });
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
