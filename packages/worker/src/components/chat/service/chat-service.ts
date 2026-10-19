import {
    decodeIdentifier,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionStatusChangedEvent,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import { PlatformProjectError } from "../../management/entity/platform-project.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionStorage } from "../storage/managed-session-storage.ts";

interface AuditLogger {
    readonly info: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

const STATUS_LIVENESS_MILLISECONDS = 120_000;

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
type NativePreviewInput = Omit<NativeEntryInput, "discoveryId"> & { readonly nativeSessionId: string };
type OpenChatInput =
    | { readonly conversationId: string; readonly title?: string }
    | {
          readonly agentRef: string;
          readonly conversationKey: string;
          readonly configurations: readonly {
              readonly booleanValue: boolean;
              readonly configId: string;
              readonly value: string;
              readonly valueType: "select" | "boolean";
          }[];
          readonly title?: string;
          readonly workspaceRef: string;
      }
    | {
          readonly agentRef: string;
          readonly conversationKey: string;
          readonly permissionMode: string;
          readonly title?: string;
          readonly configuration: {
              readonly additionalDirectoryIds: readonly string[];
              readonly booleanValue: boolean;
              readonly configId: string;
              readonly value: string;
              readonly valueType: "select" | "boolean";
          };
          readonly workspaceRef: string;
      };
type ConfigureBotInput = {
    readonly runtimeId: string;
    readonly agentRef: string;
};

async function chatSessionId(botId: string, conversationKey: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${botId}\u0000${conversationKey}`));
    return `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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
        const [ownsProject, ownsBot] = await timing.measure(
            "ownership",
            "Verify Project and Machine ownership",
            async () =>
                Promise.all([
                    this.#identities.ownsProject(userId, projectId, signal),
                    this.#managedBots.ownsBot(userId, botId, signal),
                ]),
        );
        if (!ownsProject) {
            throw new PlatformProjectError("NOT_FOUND", "Your Morty data was not found.", 404);
        }
        if (!ownsBot) {
            throw new PlatformProjectError("NOT_FOUND", "Your Machine was not found.", 404);
        }
        return { userId, projectId, botId, signal };
    };

    readonly runtimeConfiguration = async (scope: ChatScope) => {
        const runtime = await this.localRuntime(scope);
        return {
            runtime: await this.#platform.getChatRuntimeAgents(scope.projectId, runtime.runtimeId, scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope) => {
        const runtime = await this.localRuntime(scope);
        return await this.#platform.readRuntimeDiagnostics(scope.projectId, runtime.runtimeId, scope.signal);
    };

    readonly networkDiagnostic = async (scope: ChatScope) => {
        const runtime = await this.localRuntime(scope);
        const [mortyMobiusLatencyMs, mobiusDaemonLatencyMs] = await Promise.all([
            this.#platform.measureMobiusLatency(scope.projectId, scope.signal),
            this.#platform.measureRuntimeLatency(scope.projectId, runtime.runtimeId, scope.signal),
        ]);
        return {
            mobiusOrigin: this.#platform.configuration().origin,
            mobiusDaemonLatencyMs,
            mortyMobiusLatencyMs,
        };
    };

    readonly setupRuntimes = async (scope: ChatScope) => {
        const bot = await this.#bot(scope);
        if (bot.configuration !== null) {
            throw new PlatformProjectError("BOT_RUNTIME_FIXED", "This Machine already has a configured Runtime.", 409);
        }
        return { runtimes: await this.#platform.chatRuntimes(scope.projectId, scope.signal) };
    };

    readonly listDirectory = async (scope: ChatScope, directoryId: string) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        const listing = await this.#platform.listChatDirectory(
            scope.projectId,
            bot.configuration.runtimeId,
            directoryId,
            scope.signal,
        );
        this.#logger.info(
            {
                event: "chat-directory-listed",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
            },
            "Chat audit event",
        );
        return listing;
    };

    readonly #bot = async (scope: ChatScope) => {
        const bot = await this.#managedBots.readBot(scope.userId, scope.botId, scope.signal);
        if (bot === null) {
            throw new PlatformProjectError("NOT_FOUND", "Your Machine was not found.", 404);
        }
        return bot;
    };

    readonly localRuntime = async (scope: ChatScope) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect an Agent to this Machine first.", 409);
        }
        return bot.configuration;
    };

    readonly #requireRuntimeAgent = async (scope: ChatScope, runtimeId: string, agentRef: string) => {
        const runtime = await this.#platform.getChatRuntimeAgents(scope.projectId, runtimeId, scope.signal);
        if (!runtime.agents.some((agent) => agent.agentRef === agentRef)) {
            throw new PlatformProjectError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Machine's Runtime.",
                409,
            );
        }
    };

    readonly managedSessions = async (scope: ChatScope) => {
        const runtime = await this.localRuntime(scope);
        const owned = await this.#chatSessions.list(scope.projectId, scope.userId, scope.botId, scope.signal);
        if (owned.length === 0) {
            return { sessions: [] };
        }
        const metadata = await this.#platform.queryChatSessions(
            scope.projectId,
            runtime.runtimeId,
            owned.map((session) => session.id),
            scope.signal,
        );
        const byId = new Map(metadata.map((session) => [session.sessionId, session]));
        return {
            sessions: owned.map((session) => {
                const details = byId.get(session.id);
                const createdAt = new Date(session.createdAt).toISOString();
                return {
                    ...session,
                    createdAt,
                    additionalDirectoryIds:
                        details?.additionalDirectories.map((directory) => directory.directoryId) ?? [],
                    directoryId: details?.directoryId ?? "default",
                    directoryLabel: details?.directoryLabel ?? "",
                    isExternal: false,
                    status: details?.status ?? { kind: "idle" },
                    title: details?.title ?? "New chat",
                    updatedAt: details?.updatedAt ?? createdAt,
                };
            }),
        };
    };

    readonly subscribeManagedSessionStatuses = async (
        scope: ChatScope,
        publish: (event: SessionStatusChangedEvent) => void,
        signal: AbortSignal,
    ): Promise<void> => {
        const runtime = await this.localRuntime(scope);
        const ownedSessions = await this.#chatSessions.list(scope.projectId, scope.userId, scope.botId, scope.signal);
        scope.signal.throwIfAborted();
        const owned = new Set<string>(ownedSessions.map((session) => session.id));
        const socket = await this.#platform.openChatRuntimeHost(scope.projectId, runtime.runtimeId, signal);
        await new Promise<void>((_resolve, reject) => {
            let settled = false;
            let liveness: ReturnType<typeof setTimeout>;
            const finish = (cause: unknown): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(liveness);
                signal.removeEventListener("abort", aborted);
                socket.removeEventListener("close", closed);
                socket.removeEventListener("error", closed);
                socket.removeEventListener("message", message);
                socket.close(1000, "Session status subscription closed");
                reject(cause);
            };
            const refreshLiveness = (): void => {
                clearTimeout(liveness);
                liveness = setTimeout(
                    () =>
                        finish(new PlatformProjectError("PLATFORM_TIMEOUT", "Session status updates timed out.", 504)),
                    STATUS_LIVENESS_MILLISECONDS,
                );
            };
            const aborted = (): void => finish(signal.reason);
            const closed = (): void =>
                finish(new PlatformProjectError("RUNTIME_UNAVAILABLE", "The local Runtime disconnected.", 503));
            const message = (event: MessageEvent): void => {
                try {
                    if (typeof event.data !== "string") {
                        throw new PlatformProjectError(
                            "PLATFORM_INVALID_RESPONSE",
                            "Platform returned an invalid Session status event.",
                            502,
                        );
                    }
                    refreshLiveness();
                    const kind = decodeMessageKind(event.data);
                    if (kind === "runtime.status") {
                        if (!decodeRuntimeStatusEvent(event.data).online) {
                            closed();
                        }
                        return;
                    }
                    if (kind !== "session.status.changed") {
                        return;
                    }
                    const status = decodeSessionStatusChangedEvent(event.data);
                    if (owned.has(status.sessionId)) {
                        publish(status);
                    }
                } catch (cause) {
                    finish(
                        cause instanceof PlatformProjectError
                            ? cause
                            : new PlatformProjectError(
                                  "PLATFORM_INVALID_RESPONSE",
                                  "Platform returned an invalid Session status event.",
                                  502,
                                  { cause },
                              ),
                    );
                }
            };
            refreshLiveness();
            signal.addEventListener("abort", aborted, { once: true });
            socket.addEventListener("close", closed, { once: true });
            socket.addEventListener("error", closed, { once: true });
            socket.addEventListener("message", message);
            socket.accept();
            if (signal.aborted) {
                aborted();
            }
        });
    };

    readonly agentSettings = async (scope: ChatScope, agentRef: string) => {
        const bot = await this.#bot(scope);
        if (bot?.configuration === null || bot === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        await this.#requireRuntimeAgent(scope, bot.configuration.runtimeId, agentRef);
        const discovered = await this.#platform.discoverChatAgentSettings(
            scope.projectId,
            { runtimeId: bot.configuration.runtimeId, agentRef, workspaceRef: "default" },
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

    readonly openChat = async (scope: ChatScope, input: OpenChatInput, timing: OperationTiming) => {
        const bot = await this.#bot(scope);
        if (bot?.configuration === null || bot === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect your local agent to start chatting.", 409);
        }
        const runtime = bot.configuration;
        if (runtime === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect your local agent to start chatting.", 409);
        }
        if ("conversationKey" in input) {
            await this.#requireRuntimeAgent(scope, runtime.runtimeId, input.agentRef);
        }
        const access = await timing.measure("session", "Open Chat Session", async () =>
            this.#platform.openChatSession(
                scope.projectId,
                "conversationKey" in input
                    ? {
                          ...input,
                          kind: "new",
                          bindingId: `binding_${crypto.randomUUID()}`,
                          runtimeId: runtime.runtimeId,
                          conversationKey: await chatSessionId(scope.botId, input.conversationKey),
                      }
                    : await (async () => {
                          const metadata = (
                              await this.#platform.queryChatSessions(
                                  scope.projectId,
                                  runtime.runtimeId,
                                  [input.conversationId],
                                  scope.signal,
                              )
                          ).find((session) => session.sessionId === input.conversationId);
                          if (metadata === undefined) {
                              throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
                          }
                          return {
                              kind: "existing" as const,
                              conversationId: input.conversationId,
                              runtimeId: runtime.runtimeId,
                              agentRef: metadata.agentId,
                              workspaceRef: metadata.directoryId,
                              additionalDirectoryIds: metadata.additionalDirectories.map(
                                  (directory) => directory.directoryId,
                              ),
                          };
                      })(),
                input.title ?? "New chat",
                scope.signal,
            ),
        );
        if ("conversationKey" in input) {
            await timing.measure("session-save", "Save managed Chat session", async () =>
                this.#chatSessions.save(
                    scope.projectId,
                    scope.userId,
                    scope.botId,
                    { id: access.conversationId },
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
        return { ...access, instructions: bot.instructions };
    };

    readonly nativeSessionAccess = async (scope: ChatScope, sessionId: string) => {
        const runtime = await this.localRuntime(scope);
        const access = await this.#platform.nativeSessionAccess(
            scope.projectId,
            runtime.runtimeId,
            sessionId,
            scope.signal,
        );
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

    readonly managedSession = async (scope: ChatScope, sessionId: string) => {
        const bot = await this.#bot(scope);
        if (
            !(await this.#chatSessions.ownsSession(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal))
        ) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        const runtime = await this.localRuntime(scope);
        return {
            ...(await this.#platform.readChatSession(scope.projectId, runtime, sessionId, scope.signal)),
            instructions: bot.instructions,
        };
    };

    readonly archiveManagedSession = async (scope: ChatScope, sessionId: string): Promise<Record<string, never>> => {
        if (
            !(await this.#chatSessions.ownsSession(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal))
        ) {
            return {};
        }
        const runtime = await this.localRuntime(scope);
        try {
            await this.#platform.closeChatSession(scope.projectId, runtime.runtimeId, sessionId, scope.signal);
        } catch (cause) {
            scope.signal.throwIfAborted();
            this.#logger.info(
                {
                    event: "chat-managed-session-close-failed",
                    userId: scope.userId,
                    projectId: scope.projectId,
                    botId: scope.botId,
                    sessionId,
                    failureCode: cause instanceof PlatformProjectError ? cause.code : "unexpected_failure",
                },
                "Chat audit event",
            );
        }
        await this.#chatSessions.archive(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal);
        this.#logger.info(
            {
                event: "chat-managed-session-archived",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                sessionId,
            },
            "Chat audit event",
        );
        return {};
    };

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

    readonly continueNativeSession = async (
        scope: ChatScope,
        harness: string,
        sessionId: string,
        action: "fork" | "import",
    ) => {
        const bot = await this.#bot(scope);
        const runtime =
            bot.configuration === null
                ? undefined
                : await this.#platform.getChatRuntimeAgents(scope.projectId, bot.configuration.runtimeId, scope.signal);
        const agent = runtime?.agents.find((item) => item.agentRef === harness);
        if (runtime === undefined || agent === undefined) {
            throw new PlatformProjectError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        const found = await this.#platform.findNativeSessionByNativeSessionId(
            scope.projectId,
            runtime.runtimeId,
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
            runtime.runtimeId,
            {
                action,
                discoveryId: found.sessionId,
                agentId: agent.agentRef,
                directoryId: entry.directoryId,
                additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                entryId: entry.entryId,
            },
            scope.signal,
        );
        if (result.action !== action || (action === "fork" && result.ready.sessionId !== result.targetSessionId)) {
            throw new PlatformProjectError(
                action === "import" ? "IMPORT_UNAVAILABLE" : "CONTINUATION_UNAVAILABLE",
                action === "import"
                    ? "The original session could not be imported. You can choose Fork session instead."
                    : "The handoff session could not be forked.",
                409,
            );
        }
        const stored = { agentRef: agent.agentRef, result, entry, instructions: bot.instructions };
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            { id: result.ready.sessionId },
            scope.signal,
        );
        this.#logger.info(
            {
                event:
                    action === "fork" ? "native-session-forked-from-handoff" : "native-session-imported-from-handoff",
                userId: scope.userId,
                projectId: scope.projectId,
                botId: scope.botId,
                runtimeId: runtime.runtimeId,
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
        input: NativePreviewInput,
    ) => {
        const events = await this.#platform.previewRuntimeNativeEvents(
            scope.projectId,
            runtimeId,
            input.nativeSessionId,
            {
                additionalDirectoryIds: input.additionalDirectoryIds,
                agentId: input.agentId,
                directoryId: input.directoryId,
            },
            { cursor: null, eventLimit: 200 },
            scope.signal,
        );
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
        return events;
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
        if (result.action !== action || (action === "fork" && result.ready.sessionId !== result.targetSessionId)) {
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
            { id: result.ready.sessionId },
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
        const current = await this.#bot(scope);
        if (current.configuration !== null && current.configuration.runtimeId !== input.runtimeId) {
            throw new PlatformProjectError(
                "BOT_RUNTIME_FIXED",
                "Create a new Machine to pair a different Runtime.",
                409,
            );
        }
        await this.#requireRuntimeAgent(scope, input.runtimeId, input.agentRef);
        await this.#platform.discoverChatAgentSettings(
            scope.projectId,
            { ...input, workspaceRef: "default" },
            scope.signal,
        );
        const result = await this.#managedBots.configureBot(
            scope.userId,
            scope.botId,
            { runtimeId: decodeIdentifier(input.runtimeId) },
            Date.now(),
            scope.signal,
        );
        if (result !== "configured") {
            if (result === "runtime-mismatch") {
                throw new PlatformProjectError(
                    "BOT_RUNTIME_FIXED",
                    "Create a new Machine to pair a different Runtime.",
                    409,
                );
            }
            throw new PlatformProjectError("NOT_FOUND", "Your Machine was not found.", 404);
        }
        this.#logger.info(
            { event: "bot-setup-requested", userId: scope.userId, projectId: scope.projectId, botId: scope.botId },
            "Bot audit event",
        );
        return { status: "active" };
    };
}
