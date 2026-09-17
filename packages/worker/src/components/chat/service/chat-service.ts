import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import { PlatformProjectError } from "../../management/entity/platform-project.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionStorage } from "../storage/managed-session-storage.ts";
import type { MobiusAppService } from "./mobius-app-service.ts";

interface AuditLogger {
    readonly info: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

export type ChatScope = {
    readonly userId: string;
    readonly projectId: string;
    readonly botId: string;
    readonly signal: AbortSignal;
};

type NativeListInput = {
    readonly action: "list";
    readonly agentId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
    readonly cursor: string | null;
    readonly discoveryId: string | null;
};
type NativeEntryInput = {
    readonly agentId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
    readonly discoveryId: string;
};
type OpenChatInput = Parameters<PlatformProjectGateway["openChat"]>[4] & { readonly title?: string };
type ConfigureBotInput = Parameters<PlatformProjectGateway["configureBot"]>[3];

export class ChatService {
    readonly #chatSessions: ManagedSessionStorage;
    readonly #identities: IdentityStorage;
    readonly #managedBots: ManagedBotStorage;
    readonly #mobiusApp: MobiusAppService;
    readonly #platform: PlatformProjectGateway;
    readonly #logger: AuditLogger;

    constructor(cx: {
        readonly gateways: { readonly platformProjects: PlatformProjectGateway };
        readonly storages: {
            readonly chatSessions: ManagedSessionStorage;
            readonly identities: IdentityStorage;
            readonly managedBots: ManagedBotStorage;
        };
        readonly services: { readonly mobiusApp: MobiusAppService };
        readonly logger: AuditLogger;
    }) {
        this.#chatSessions = cx.storages.chatSessions;
        this.#identities = cx.storages.identities;
        this.#managedBots = cx.storages.managedBots;
        this.#mobiusApp = cx.services.mobiusApp;
        this.#platform = cx.gateways.platformProjects;
        this.#logger = cx.logger;
    }

    readonly authorize = async (
        userId: string,
        projectId: string,
        botId: string,
        signal: AbortSignal,
        timing: OperationTiming,
    ): Promise<ChatScope> => {
        const [ownsProject, ownsBot] = await timing.measure("ownership", "Verify Project and Bot ownership", async () =>
            Promise.all([
                this.#identities.ownsProject(userId, projectId, signal),
                this.#managedBots.ownsBot(userId, botId, signal),
            ]),
        );
        if (!ownsProject) {
            throw new PlatformProjectError("NOT_FOUND", "Your Project was not found.", 404);
        }
        if (!ownsBot) {
            throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
        }
        return { userId, projectId, botId, signal };
    };

    readonly workspace = async (scope: ChatScope) =>
        await this.#platform.chatWorkspace(scope.projectId, scope.botId, scope.userId, scope.signal);

    readonly managedSessions = async (scope: ChatScope) => ({
        sessions: await this.#chatSessions.list(scope.projectId, scope.userId, scope.botId, scope.signal),
    });

    readonly agentSettings = async (scope: ChatScope) => {
        const settings = await this.#platform.agentSettings(scope.projectId, scope.botId, scope.userId, scope.signal);
        this.#logger.info(
            {
                event: "chat-agent-settings-discovered",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
            },
            "Chat audit event",
        );
        return settings;
    };

    readonly openChat = async (scope: ChatScope, input: OpenChatInput, timing: OperationTiming) => {
        const access = await this.#platform.openChat(
            scope.projectId,
            scope.botId,
            scope.userId,
            scope.signal,
            input,
            timing,
        );
        if ("conversationKey" in input) {
            await timing.measure("session-save", "Save managed Chat session", async () =>
                this.#chatSessions.save(
                    scope.projectId,
                    scope.userId,
                    scope.botId,
                    { kind: "conversation", id: access.conversationId, title: input.title ?? "New chat" },
                    scope.signal,
                ),
            );
        }
        this.#logger.info(
            {
                event: "bot-chat-access-issued",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                conversationId: access.conversationId,
            },
            "Chat audit event",
        );
        return access;
    };

    readonly nativeSessionAccess = async (scope: ChatScope, sessionId: string) => {
        const access = await this.#platform.nativeSessionAccess(scope.projectId, sessionId, scope.signal);
        this.#logger.info(
            {
                event: "session-access-issued",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                sessionId,
            },
            "Chat audit event",
        );
        return access;
    };

    readonly managedSession = async (scope: ChatScope, sessionId: string) =>
        await this.#chatSessions.readLocalSession(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal);

    readonly nativeSessions = async (scope: ChatScope, runtimeId: string, input: NativeListInput) => {
        const result = await this.#platform.nativeSessions(scope.projectId, runtimeId, input, scope.signal);
        if (result.action !== "list") {
            throw new PlatformProjectError(
                "PLATFORM_INVALID_RESPONSE",
                "The agent returned an invalid session directory.",
                502,
            );
        }
        this.#logger.info(
            {
                event: "native-session-listed",
                projectId: scope.projectId,
                userId: scope.userId,
                botId: scope.botId,
                runtimeId,
            },
            "Chat audit event",
        );
        return result;
    };

    readonly continueNativeSession = async (scope: ChatScope, harness: string, sessionId: string) => {
        const workspace = await this.workspace(scope);
        const selected = workspace.selected;
        const agent = workspace.agents.find(
            (item) =>
                selected !== null &&
                item.runtimeId === selected.runtimeId &&
                item.agentRef === selected.agentRef &&
                item.agentRef === harness &&
                item.online,
        );
        if (agent === undefined) {
            throw new PlatformProjectError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        const found = await this.#platform.findNativeSessionByNativeSessionId(
            scope.projectId,
            agent.runtimeId,
            {
                agentId: agent.agentRef,
                directoryId: "default",
                additionalDirectoryIds: [],
                nativeSessionId: sessionId,
            },
            scope.signal,
        );
        const entry = found.entry;
        const result = await this.#platform.nativeSessions(
            scope.projectId,
            agent.runtimeId,
            {
                action: "fork",
                discoveryId: found.sessionId,
                agentId: agent.agentRef,
                directoryId: entry.directoryId,
                additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                entryId: entry.entryId,
            },
            scope.signal,
        );
        if (result.action !== "fork" || result.ready.sessionId !== result.targetSessionId) {
            throw new PlatformProjectError(
                "CONTINUATION_UNAVAILABLE",
                "The handoff session could not be continued.",
                409,
            );
        }
        const stored = { agentRef: agent.agentRef, result, entry };
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            {
                kind: "fork",
                id: result.ready.sessionId,
                title: result.title || "Untitled session",
                data: JSON.stringify(stored),
            },
            scope.signal,
        );
        this.#logger.info(
            {
                event: "native-session-forked-from-handoff",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                runtimeId: agent.runtimeId,
                harness,
            },
            "Chat audit event",
        );
        return stored;
    };

    readonly previewNativeSession = async (
        scope: ChatScope,
        runtimeId: string,
        entryId: string,
        input: NativeEntryInput,
    ) => {
        const result = await this.#platform.nativeSessions(
            scope.projectId,
            runtimeId,
            { ...input, entryId, action: "preview" },
            scope.signal,
        );
        if (result.action !== "preview") {
            throw new PlatformProjectError(
                "PLATFORM_INVALID_RESPONSE",
                "The agent returned an invalid session preview.",
                502,
            );
        }
        this.#logger.info(
            {
                event: "native-session-previewed",
                projectId: scope.projectId,
                userId: scope.userId,
                botId: scope.botId,
                runtimeId,
                entryId,
            },
            "Chat audit event",
        );
        return { title: result.title, history: result.history };
    };

    readonly importNativeSession = async (
        scope: ChatScope,
        runtimeId: string,
        entryId: string,
        input: NativeEntryInput,
    ) => await this.#openNativeSession(scope, runtimeId, entryId, input, "import");

    readonly forkNativeSession = async (
        scope: ChatScope,
        runtimeId: string,
        entryId: string,
        input: NativeEntryInput,
    ) => await this.#openNativeSession(scope, runtimeId, entryId, input, "fork");

    readonly #openNativeSession = async (
        scope: ChatScope,
        runtimeId: string,
        entryId: string,
        input: NativeEntryInput,
        action: "fork" | "import",
    ) => {
        const result = await this.#platform.nativeSessions(
            scope.projectId,
            runtimeId,
            { ...input, entryId, action },
            scope.signal,
        );
        if (result.action !== action || result.ready.sessionId !== result.targetSessionId) {
            throw new PlatformProjectError(
                action === "fork" ? "FORK_UNAVAILABLE" : "IMPORT_UNAVAILABLE",
                `This agent cannot ${action} the selected local session.`,
                409,
            );
        }
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            {
                kind: action,
                id: result.ready.sessionId,
                title: result.title || "Untitled session",
                data: JSON.stringify({
                    agentRef: input.agentId,
                    result,
                    entry: {
                        entryId,
                        title: result.title,
                        directoryId: input.directoryId,
                        directoryLabel: input.directoryId,
                        additionalDirectories: result.ready.additionalDirectories,
                        updatedAt: null,
                    },
                }),
            },
            scope.signal,
        );
        this.#logger.info(
            {
                event: action === "fork" ? "native-session-forked" : "native-session-imported",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                runtimeId,
                entryId,
            },
            "Chat audit event",
        );
        return result;
    };

    readonly configureBot = async (scope: ChatScope, input: ConfigureBotInput) => {
        const result = await this.#platform.configureBot(
            scope.projectId,
            scope.botId,
            scope.userId,
            input,
            scope.signal,
        );
        this.#logger.info(
            { event: "bot-setup-requested", userId: scope.userId, projectId: scope.projectId, botId: scope.botId },
            "Bot audit event",
        );
        return result;
    };

    readonly issueAccessToken = async (userId: string, botId: string, signal: AbortSignal) => {
        if (!(await this.#managedBots.ownsBot(userId, botId, signal))) {
            throw new PlatformProjectError("NOT_FOUND", "Not found.", 404);
        }
        const accessToken = await this.#mobiusApp.issueAccessToken(botId, null, signal);
        try {
            await this.#managedBots.saveAccessToken(userId, botId, accessToken.accessTokenId, Date.now(), signal);
        } catch (cause) {
            await this.#mobiusApp.revokeAccessToken(accessToken.accessTokenId, AbortSignal.timeout(10_000));
            signal.throwIfAborted();
            throw cause;
        }
        return accessToken;
    };

    readonly revokeAccessToken = async (userId: string, accessTokenId: string, signal: AbortSignal) => {
        if (!(await this.#managedBots.ownsAccessToken(userId, accessTokenId, signal))) {
            throw new PlatformProjectError("NOT_FOUND", "Not found.", 404);
        }
        await this.#mobiusApp.revokeAccessToken(accessTokenId, signal);
        await this.#managedBots.deleteAccessToken(userId, accessTokenId, signal);
    };

    readonly listSessions = async (userId: string, signal: AbortSignal) =>
        await this.#managedBots.listSessions(userId, signal);

    readonly saveSession = async (
        userId: string,
        input: { readonly botId: string; readonly sessionId: string; readonly title: string },
        signal: AbortSignal,
    ) => await this.#managedBots.saveSession(userId, input, Date.now(), signal);

    readonly renameSession = async (userId: string, sessionId: string, title: string, signal: AbortSignal) =>
        await this.#managedBots.renameSession(userId, sessionId, title, Date.now(), signal);

    readonly deleteSession = async (userId: string, sessionId: string, signal: AbortSignal) =>
        await this.#managedBots.deleteSession(userId, sessionId, signal);
}
