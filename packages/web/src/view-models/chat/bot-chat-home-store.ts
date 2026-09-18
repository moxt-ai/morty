import { createStore } from "zustand/vanilla";
import type { BotChatApi, ChatDraftConfiguration, ChatWorkspace } from "../../services/chat/bot-chat-api.ts";
import type { ManagedBot } from "../../services/management/management-api.ts";
import { CloudApiError } from "../../services/management/management-api.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
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
type BotChatHomeView =
    | { readonly kind: "loading" }
    | { readonly kind: "switching"; readonly view: ActiveView }
    | ActiveView
    | { readonly kind: "setup"; readonly reason: SetupReason }
    | { readonly kind: "failed"; readonly message: string };

type SessionView =
    | { readonly kind: "conversation-access" }
    | { readonly kind: "session-access"; readonly session: OpenMobiusSession };

type Submission =
    | { readonly kind: "idle" }
    | { readonly kind: "sending" }
    | { readonly kind: "failed"; readonly message: string };

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (kind: "conversation" | "fork" | "import", id: string) => void;
    readonly showContinuedSession: (sessionId: string) => void;
    readonly showForkInstead: () => void;
}

export interface BotChatHomeStore {
    readonly view: BotChatHomeView;
    readonly target: Target;
    readonly sessionView: SessionView;
    readonly submission: Submission;
    readonly revision: number;
    readonly draftSettings: ChatDraftConfiguration | null;
    readonly load: (signal: AbortSignal) => Promise<void>;
    readonly newConversation: () => void;
    readonly openManaged: (kind: "conversation" | "fork" | "import", id: string) => void;
    readonly retry: () => void;
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
    },
) => {
    const conversations = createConversationSessionStore(requests);
    const target = initialTarget(options.url, options.createId);
    return createStore<BotChatHomeStore>()((set, get) => ({
        view: { kind: "loading" },
        target,
        sessionView: { kind: "conversation-access" },
        submission: { kind: "idle" },
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
            let openedBotId: string | null = null;
            try {
                const bot = (await requests.listBots(signal))[0];
                if (bot === undefined) {
                    throw new Error("Your Bot is unavailable.");
                }
                openedBotId = bot.botId;
                const workspace = await requests.workspace(bot.botId, signal);
                signal.throwIfAborted();
                const currentTarget = get().target;
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
                    return;
                }
                if (currentTarget.kind === "session-access") {
                    const session = await requests.managedSession(bot.botId, currentTarget.sessionId, signal);
                    signal.throwIfAborted();
                    set({ view: { kind: "draft", bot }, sessionView: { kind: "session-access", session } });
                    return;
                }
                const reason = currentTarget.kind === "draft" ? setupReason(workspace) : null;
                if (reason !== null) {
                    set({ view: { kind: "setup", reason } });
                    await requests.waitForWorkspaceChange(bot.botId, signal);
                    signal.throwIfAborted();
                    set((current) => ({ revision: current.revision + 1 }));
                    return;
                }
                if (currentTarget.kind === "draft") {
                    set({ view: { kind: "draft", bot } });
                    return;
                }
                await conversations.getState().open(bot.botId, currentTarget.conversationId, signal);
                const opened = conversations.getState().state;
                if (opened.kind !== "ready") {
                    throw new Error(opened.kind === "failed" ? opened.message : "The Session could not be opened.");
                }
                set({ view: { kind: "draft", bot }, sessionView: { kind: "session-access", session: opened.session } });
            } catch (cause) {
                signal.throwIfAborted();
                if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                    set({ view: { kind: "setup", reason: "agent-required" } });
                    if (openedBotId !== null) {
                        await requests.waitForWorkspaceChange(openedBotId, signal);
                        signal.throwIfAborted();
                        set((current) => ({ revision: current.revision + 1 }));
                    }
                    return;
                }
                set({
                    view: { kind: "failed", message: cause instanceof Error ? cause.message : "Chat is unavailable." },
                });
            }
        },
        newConversation: () => {
            options.navigation.showDraft();
            set((current) => ({
                target: { kind: "draft", key: options.createId() },
                sessionView: { kind: "conversation-access" },
                submission: { kind: "idle" },
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
                submission: { kind: "idle" },
                draftSettings: null,
                revision: current.revision + 1,
            }));
        },
        retry: () => set((current) => ({ revision: current.revision + 1 })),
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
            set({ submission: { kind: "sending" } });
            const content = draft.trim();
            try {
                await conversations
                    .getState()
                    .create(
                        current.view.bot.botId,
                        current.target.key,
                        current.draftSettings,
                        (
                            content ||
                            attachments
                                .map((attachment) =>
                                    attachment.kind === "image" ? attachment.image.name : attachment.resource.name,
                                )
                                .join(", ")
                        ).slice(0, 500),
                        content,
                        attachments,
                        signal,
                    );
                const opened = conversations.getState().state;
                if (opened.kind !== "ready") {
                    throw new Error(opened.kind === "failed" ? opened.message : "The Session could not be created.");
                }
                signal.throwIfAborted();
                options.navigation.showManaged("conversation", opened.conversationId);
                set({
                    target: { kind: "conversation-access", conversationId: opened.conversationId },
                    sessionView: { kind: "session-access", session: opened.session },
                    submission: { kind: "idle" },
                });
                return true;
            } catch (cause) {
                signal.throwIfAborted();
                set({
                    submission: {
                        kind: "failed",
                        message: cause instanceof Error ? cause.message : "The message could not be sent.",
                    },
                });
                return false;
            }
        },
    }));
};
