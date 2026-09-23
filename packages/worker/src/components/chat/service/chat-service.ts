import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import { PlatformProjectError } from "../../management/entity/platform-project.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionStorage } from "../storage/managed-session-storage.ts";

interface AuditLogger {
    readonly info: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

export type ChatScope = {
    readonly userId: string;
    readonly projectId: string;
    readonly botId: string;
    readonly signal: AbortSignal;
};

type ConfigureBotInput = {
    readonly runtimeId: string;
    readonly agentRef: string;
};

export class ChatService {
    readonly #chatSessions: ManagedSessionStorage;
    readonly #identities: IdentityStorage;
    readonly #managedBots: ManagedBotStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #logger: AuditLogger;

    constructor(cx: {
        readonly gateways: { readonly platformProjects: PlatformProjectGateway };
        readonly storages: {
            readonly chatSessions: ManagedSessionStorage;
            readonly identities: IdentityStorage;
            readonly managedBots: ManagedBotStorage;
        };
        readonly logger: AuditLogger;
    }) {
        this.#chatSessions = cx.storages.chatSessions;
        this.#identities = cx.storages.identities;
        this.#managedBots = cx.storages.managedBots;
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
            throw new PlatformProjectError("NOT_FOUND", "Your workspace was not found.", 404);
        }
        if (!ownsBot) {
            throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
        }
        return { userId, projectId, botId, signal };
    };

    readonly workspace = async (scope: ChatScope) => await this.#localWorkspace(scope);

    readonly #bot = async (scope: ChatScope) => {
        const bot = await this.#managedBots.readBot(scope.userId, scope.botId, scope.signal);
        if (bot === null) {
            throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
        }
        return bot;
    };

    readonly #localWorkspace = async (scope: ChatScope) => {
        const bot = await this.#bot(scope);
        return {
            status: bot.configuration === null ? "draft" : "active",
            runtimeId: bot.configuration?.runtimeId ?? null,
            agents: await this.#platform.chatAgents(scope.projectId, scope.signal),
        };
    };

    readonly localRuntime = async (scope: ChatScope) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect an Agent to this Bot first.", 409);
        }
        return bot.configuration;
    };

    readonly createLocalSession = async (
        scope: ChatScope,
        input: { readonly action: "create" } | { readonly action: "import"; readonly sessionId: string },
    ) => {
        const runtime = await this.localRuntime(scope);
        const selected = await (async () => {
            if (input.action === "create") {
                const result = await this.#platform.nativeSessions(
                    scope.projectId,
                    runtime.runtimeId,
                    {
                        action: "create",
                        agentId: runtime.agentRef,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                    },
                    scope.signal,
                );
                if (result.action !== "create") {
                    throw new PlatformProjectError("INVALID_SESSION", "The Agent did not create a Session.", 502);
                }
                return {
                    sessionId: result.nativeSessionId,
                    title: "New chat",
                    directoryId: "default",
                    additionalDirectoryIds: [],
                };
            }
            const found = await this.#platform.findNativeSessionByNativeSessionId(
                scope.projectId,
                runtime.runtimeId,
                {
                    agentId: runtime.agentRef,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    nativeSessionId: input.sessionId,
                },
                scope.signal,
            );
            if (found.entry.nativeSessionId !== input.sessionId) {
                throw new PlatformProjectError("INVALID_SESSION", "The Agent returned a different Session.", 502);
            }
            return {
                sessionId: found.entry.nativeSessionId,
                title: found.entry.title || "New chat",
                directoryId: found.entry.directoryId,
                additionalDirectoryIds: found.entry.additionalDirectories.map((item) => item.directoryId),
            };
        })();
        const sessionId = selected.sessionId;
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            {
                isExternal: false,
                id: sessionId,
                title: selected.title,
                directoryId: selected.directoryId,
                additionalDirectoryIds: selected.additionalDirectoryIds,
            },
            scope.signal,
        );
        this.#logger.info(
            { event: "chat-session-created", projectId: scope.projectId, userId: scope.userId, botId: scope.botId },
            "Chat audit event",
        );
        return { sessionId, runtimeId: runtime.runtimeId, agentRef: runtime.agentRef };
    };

    readonly localSessions = async (scope: ChatScope) => ({
        sessions: (await this.#chatSessions.list(scope.projectId, scope.userId, scope.botId, scope.signal)).map(
            (session) => ({ ...session, directoryLabel: "" }),
        ),
    });

    readonly requireLocalSession = async (scope: ChatScope, sessionId: string) => {
        if (
            !(await this.#chatSessions.ownsSession(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal))
        ) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        return await this.localRuntime(scope);
    };

    readonly agentSettings = async (scope: ChatScope, agentRef: string) => {
        const bot = await this.#bot(scope);
        if (bot?.configuration === null || bot === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        const discovered = await this.#platform.discoverChatAgentSettings(
            scope.projectId,
            { runtimeId: bot.configuration.runtimeId, agentRef },
            scope.signal,
        );
        this.#logger.info(
            {
                event: "chat-agent-settings-discovered",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
            },
            "Chat audit event",
        );
        return { settings: discovered };
    };

    readonly configureBot = async (scope: ChatScope, input: ConfigureBotInput) => {
        const current = await this.#bot(scope);
        if (current.configuration !== null && current.configuration.runtimeId !== input.runtimeId) {
            throw new PlatformProjectError("BOT_RUNTIME_FIXED", "Create a new Bot to pair a different Runtime.", 409);
        }
        const agents = await this.#platform.chatAgents(scope.projectId, scope.signal);
        if (
            !agents.some(
                (agent) => agent.runtimeId === input.runtimeId && agent.agentRef === input.agentRef && agent.online,
            )
        ) {
            throw new PlatformProjectError(
                "AGENT_UNAVAILABLE",
                "Choose an available agent on your connected Runtime.",
                409,
            );
        }
        await this.#platform.discoverChatAgentSettings(scope.projectId, input, scope.signal);
        const result = await this.#managedBots.configureBot(
            scope.userId,
            scope.botId,
            { runtimeId: input.runtimeId, agentRef: input.agentRef },
            Date.now(),
            scope.signal,
        );
        if (result !== "configured") {
            throw result === "runtime-mismatch"
                ? new PlatformProjectError("BOT_RUNTIME_FIXED", "Create a new Bot to pair a different Runtime.", 409)
                : new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
        }
        this.#logger.info(
            { event: "bot-setup-requested", userId: scope.userId, projectId: scope.projectId, botId: scope.botId },
            "Bot audit event",
        );
        return { status: "active" };
    };
}
