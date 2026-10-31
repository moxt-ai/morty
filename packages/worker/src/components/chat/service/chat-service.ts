import {
    decodeIdentifier,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionStatusChangedEvent,
    SESSION_CLOSE_NOTICE_KIND,
    type SessionCloseNoticeEvent,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import { PlatformProjectError } from "../../management/entity/platform-project.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";
import type { ManagedSessionStorage } from "../storage/managed-session-storage.ts";

const STATUS_LIVENESS_MILLISECONDS = 120_000;

/**
 * Sent once the stream reaches the Runtime. `sessions: "owned"` promises that `statuses` holds the current status of
 * each Session the user owns and that the changes of every Session the user owns follow, including Sessions created
 * later. An older Chat Worker sent neither: it followed only the changes of the Sessions owned when the stream started.
 */
export const MANAGED_SESSION_STATUSES_FOLLOWING_KIND = "managed-session.statuses.following";

/**
 * What the managed Session stream tells a client: it now follows the Sessions as they currently are, a Session's
 * activity changed, or the Runtime closed a Session.
 */
export type ManagedSessionEvent =
    | {
          readonly kind: typeof MANAGED_SESSION_STATUSES_FOLLOWING_KIND;
          readonly sessions: "owned";
          readonly statuses: readonly Omit<SessionStatusChangedEvent, "kind">[];
      }
    | SessionStatusChangedEvent
    | SessionCloseNoticeEvent;

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
type NewChatInput = {
    readonly agentRef: string;
    readonly conversationKey: string;
    readonly configurations: readonly {
        readonly booleanValue: boolean;
        readonly configId: string;
        readonly value: string;
        readonly valueType: "select" | "boolean";
    }[];
    readonly title: string;
    readonly workspaceRef: string;
};
type OpenChatInput = { readonly conversationId: string } | NewChatInput;
type ConfigureBotInput = {
    readonly runtimeId: string;
    readonly agentRef: string;
};
type ManagedSessionArchival = { readonly close: "confirmed" | "unconfirmed" };

async function chatSessionId(botId: string, conversationKey: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${botId}\u0000${conversationKey}`));
    return `chat_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function notInRecentSessions(): never {
    throw new PlatformProjectError(
        "NOT_FOUND",
        'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
        404,
    );
}

/**
 * A managed Session that the scope's user owns through its Machine. `find` is the only way to construct one: it reads
 * Morty's ownership record, so work on an existing managed Session cannot start from an unchecked client identifier.
 */
class OwnedManagedSession {
    readonly scope: ChatScope;
    readonly #sessionId: string;

    private constructor(scope: ChatScope, sessionId: string) {
        this.scope = scope;
        this.#sessionId = sessionId;
    }

    get sessionId(): string {
        return this.#sessionId;
    }

    static readonly find = async (
        sessions: ManagedSessionStorage,
        scope: ChatScope,
        sessionId: string,
    ): Promise<OwnedManagedSession | null> =>
        (await sessions.ownsSession(scope.projectId, scope.userId, scope.botId, sessionId, scope.signal))
            ? new OwnedManagedSession(scope, sessionId)
            : null;
}

export class ChatService {
    readonly #chatSessions: ManagedSessionStorage;
    readonly #identities: IdentityStorage;
    readonly #managedBots: ManagedBotStorage;
    readonly #platform: PlatformProjectGateway;
    readonly #sessionOperations: ManagedSessionOperations | undefined;

    constructor(cx: {
        readonly sessionOperations: ManagedSessionOperations | undefined;
        readonly gateways: { readonly platformProjects: PlatformProjectGateway };
        readonly storages: {
            readonly chatSessions: ManagedSessionStorage;
            readonly identities: IdentityStorage;
            readonly managedBots: ManagedBotStorage;
        };
    }) {
        this.#chatSessions = cx.storages.chatSessions;
        this.#identities = cx.storages.identities;
        this.#managedBots = cx.storages.managedBots;
        this.#platform = cx.gateways.platformProjects;
        this.#sessionOperations = cx.sessionOperations;
    }

    readonly authorize = async (
        userId: string,
        projectId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<ChatScope> => {
        const [ownsProject, ownsBot] = await Promise.all([
            this.#identities.ownsProject(userId, projectId, signal),
            this.#managedBots.ownsBot(userId, botId, signal),
        ]);
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

    /**
     * Runs an operation on an existing managed Session after every earlier one on that Session has finished. Ownership
     * is resolved inside that turn, so archival cannot overtake a reopen that has already passed the check. `notOwned`
     * is what the endpoint reports for a Session the scope does not own.
     */
    readonly #withOwnedManagedSession = <Result>(
        scope: ChatScope,
        sessionId: string,
        notOwned: () => Result,
        operation: (session: OwnedManagedSession) => Promise<Result>,
    ): Promise<Result> => {
        if (this.#sessionOperations === undefined) {
            throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
        }
        return this.#sessionOperations.run(sessionId, scope.signal, async () => {
            const session = await OwnedManagedSession.find(this.#chatSessions, scope, sessionId);
            return session === null ? notOwned() : await operation(session);
        });
    };

    readonly #nativeSessionRuntime = async (scope: ChatScope, requestedRuntimeId: string) => {
        const runtime = await this.localRuntime(scope);
        // The client names the Runtime its native-session identity came from. Discovery and entry identifiers belong to
        // that Runtime and must not be silently redirected to another one.
        if (requestedRuntimeId !== runtime.runtimeId) {
            throw new PlatformProjectError("BOT_RUNTIME_FIXED", "This Machine is bound to a different Runtime.", 409);
        }
        return runtime;
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
                    // The Runtime titles a Session from its first prompt; until then it lists a placeholder.
                    prompted: details?.prompted ?? false,
                    status: details?.status ?? { kind: "idle" },
                    title: details?.title ?? "New chat",
                    updatedAt: details?.updatedAt ?? createdAt,
                };
            }),
        };
    };

    /**
     * Publishes the current status of each of the caller's Sessions with the following notice, then their activity
     * changes and close notices, until the stream ends. Whether a Session is the caller's is read when its event arrives, so Sessions created or
     * archived while the stream runs need no new stream.
     */
    readonly subscribeManagedSessionStatuses = async (
        scope: ChatScope,
        publish: (event: ManagedSessionEvent) => void,
        signal: AbortSignal,
    ): Promise<void> => {
        const runtime = await this.localRuntime(scope);
        scope.signal.throwIfAborted();
        const socket = await this.#platform.openChatRuntimeHost(scope.projectId, runtime.runtimeId, signal);
        // The authorization deadline bounds opening the stream, not the reads made while it runs.
        const following: ChatScope = { ...scope, signal };
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
            // Events are published in the order they arrive, each once its ownership has been read.
            let published = Promise.resolve();
            const inOrder = (step: () => Promise<void>): void => {
                published = published.then(step);
                published.catch((cause: unknown) => finish(signal.aborted ? signal.reason : cause));
            };
            const publishOwned = (event: SessionStatusChangedEvent | SessionCloseNoticeEvent): void =>
                inOrder(async () => {
                    const owned = await this.#chatSessions.ownsSession(
                        scope.projectId,
                        scope.userId,
                        scope.botId,
                        event.sessionId,
                        signal,
                    );
                    if (owned && !settled) {
                        publish(event);
                    }
                });
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
                    if (kind === SESSION_CLOSE_NOTICE_KIND) {
                        publishOwned(decodeSessionCloseNoticeEvent(event.data));
                        return;
                    }
                    if (kind === "session.status.changed") {
                        publishOwned(decodeSessionStatusChangedEvent(event.data));
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
            // The current statuses are read once the socket follows the Runtime, so no change falls between the two. A
            // change that arrives while they are read is published after them and wins.
            inOrder(async () => {
                const { sessions } = await this.managedSessions(following);
                if (!settled) {
                    publish({
                        kind: MANAGED_SESSION_STATUSES_FOLLOWING_KIND,
                        sessions: "owned",
                        statuses: sessions.map((session) => ({ sessionId: session.id, status: session.status })),
                    });
                }
            });
            socket.accept();
            if (signal.aborted) {
                aborted();
            }
        });
    };

    /** The settings a new Session of this Agent starts with in the draft's directory. */
    readonly agentSettings = async (
        scope: ChatScope,
        draft: { readonly agentRef: string; readonly workspaceRef: string },
    ) => {
        const bot = await this.#bot(scope);
        if (bot?.configuration === null || bot === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        await this.#requireRuntimeAgent(scope, bot.configuration.runtimeId, draft.agentRef);
        const discovered = await this.#platform.discoverChatAgentSettings(
            scope.projectId,
            { runtimeId: bot.configuration.runtimeId, ...draft },
            scope.signal,
        );
        return { settings: discovered };
    };

    readonly openChat = async (scope: ChatScope, input: OpenChatInput) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect your local agent to start chatting.", 409);
        }
        const runtimeId = bot.configuration.runtimeId;
        const access =
            "conversationKey" in input
                ? await this.#openNewChat(scope, runtimeId, input)
                : await this.#withOwnedManagedSession(scope, input.conversationId, notInRecentSessions, (session) =>
                      this.#reopenManagedSession(session, runtimeId),
                  );
        return { ...access, instructions: bot.instructions };
    };

    readonly #openNewChat = async (scope: ChatScope, runtimeId: string, input: NewChatInput) => {
        await this.#requireRuntimeAgent(scope, runtimeId, input.agentRef);
        const access = await this.#platform.openChatSession(
            scope.projectId,
            {
                ...input,
                kind: "new",
                runtimeId,
                conversationKey: await chatSessionId(scope.botId, input.conversationKey),
            },
            scope.signal,
        );
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            { id: access.sessionId },
            scope.signal,
        );
        return access;
    };

    readonly #reopenManagedSession = async ({ scope, sessionId }: OwnedManagedSession, runtimeId: string) => {
        const metadata = (
            await this.#platform.queryChatSessions(scope.projectId, runtimeId, [sessionId], scope.signal)
        ).find((session) => session.sessionId === sessionId);
        if (metadata === undefined) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        return await this.#platform.openChatSession(
            scope.projectId,
            {
                kind: "existing",
                conversationId: sessionId,
                runtimeId,
                agentRef: metadata.agentId,
                workspaceRef: metadata.directoryId,
                additionalDirectoryIds: metadata.additionalDirectories.map((directory) => directory.directoryId),
            },
            scope.signal,
        );
    };

    readonly nativeSessionAccess = async (scope: ChatScope, sessionId: string) => {
        const session = await OwnedManagedSession.find(this.#chatSessions, scope, sessionId);
        if (session === null) {
            throw new PlatformProjectError("NOT_FOUND", "The session was not found.", 404);
        }
        const runtime = await this.localRuntime(scope);
        return await this.#platform.nativeSessionAccess(
            scope.projectId,
            runtime.runtimeId,
            session.sessionId,
            scope.signal,
        );
    };

    readonly managedSession = async (scope: ChatScope, sessionId: string) => {
        const bot = await this.#bot(scope);
        return await this.#withOwnedManagedSession(scope, sessionId, notInRecentSessions, async (session) => {
            const runtime = await this.localRuntime(scope);
            return {
                ...(await this.#platform.readChatSession(scope.projectId, runtime, session.sessionId, scope.signal)),
                instructions: bot.instructions,
            };
        });
    };

    readonly archiveManagedSession = async (scope: ChatScope, sessionId: string): Promise<ManagedSessionArchival> =>
        await this.#withOwnedManagedSession<ManagedSessionArchival>(
            scope,
            sessionId,
            () => ({ close: "unconfirmed" }),
            async (session) => {
                const runtime = await this.localRuntime(scope);
                let close: ManagedSessionArchival["close"] = "unconfirmed";
                try {
                    await this.#platform.closeChatSession(
                        scope.projectId,
                        runtime.runtimeId,
                        session.sessionId,
                        scope.signal,
                    );
                    close = "confirmed";
                } catch {
                    scope.signal.throwIfAborted();
                }
                // Archival stays available to an offline Runtime, but does not prove its process stopped.
                await this.#chatSessions.archive(
                    scope.projectId,
                    scope.userId,
                    scope.botId,
                    session.sessionId,
                    scope.signal,
                );
                return { close };
            },
        );

    readonly nativeSessions = async (scope: ChatScope, requestedRuntimeId: string, input: NativeListInput) => {
        const runtime = await this.#nativeSessionRuntime(scope, requestedRuntimeId);
        const result = await this.#platform.nativeSessions(scope.projectId, runtime.runtimeId, input, scope.signal);
        if (result.action !== "list") {
            throw new PlatformProjectError(
                "PLATFORM_INVALID_RESPONSE",
                "The agent returned an invalid session directory.",
                502,
            );
        }
        return result;
    };

    /** Imports the native session a setup handoff names, found by its native identifier in the default workspace. */
    readonly continueNativeSession = async (scope: ChatScope, harness: string, sessionId: string) => {
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
                action: "import",
                discoveryId: found.sessionId,
                agentId: agent.agentRef,
                directoryId: entry.directoryId,
                additionalDirectoryIds: entry.additionalDirectories.map((item) => item.directoryId),
                entryId: entry.entryId,
            },
            scope.signal,
        );
        if (result.action !== "import") {
            throw new PlatformProjectError("IMPORT_UNAVAILABLE", "The original session could not be opened.", 409);
        }
        const stored = { agentRef: agent.agentRef, result, entry, instructions: bot.instructions };
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            { id: result.ready.sessionId },
            scope.signal,
        );
        return stored;
    };

    readonly previewNativeSession = async (scope: ChatScope, requestedRuntimeId: string, input: NativePreviewInput) => {
        const runtime = await this.#nativeSessionRuntime(scope, requestedRuntimeId);
        const events = await this.#platform.previewRuntimeNativeEvents(
            scope.projectId,
            runtime.runtimeId,
            input.nativeSessionId,
            {
                additionalDirectoryIds: input.additionalDirectoryIds,
                agentId: input.agentId,
                directoryId: input.directoryId,
            },
            { cursor: null, eventLimit: 200 },
            scope.signal,
        );
        return events;
    };

    readonly importNativeSession = async (
        scope: ChatScope,
        requestedRuntimeId: string,
        entryId: string,
        input: NativeEntryInput,
    ) => {
        const runtime = await this.#nativeSessionRuntime(scope, requestedRuntimeId);
        const result = await this.#platform.nativeSessions(
            scope.projectId,
            runtime.runtimeId,
            { ...input, entryId, action: "import" },
            scope.signal,
        );
        if (result.action !== "import") {
            throw new PlatformProjectError(
                "IMPORT_UNAVAILABLE",
                "This agent cannot import the selected local session.",
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
        return result;
    };

    readonly recoverableNativeFork = async (
        scope: ChatScope,
        requestedRuntimeId: string,
        operationId: string,
        input: NativePreviewInput,
    ) => {
        const runtime = await this.#nativeSessionRuntime(scope, requestedRuntimeId);
        // Operation identity belongs to this user and Machine, even when they share a Platform Project.
        const scopedOperationId = await chatSessionId(scope.botId, `${scope.userId}\u0000fork\u0000${operationId}`);
        const receipt = await this.#platform.forkNativeSession(
            scope.projectId,
            runtime.runtimeId,
            scopedOperationId,
            input,
            scope.signal,
        );
        await this.#chatSessions.save(
            scope.projectId,
            scope.userId,
            scope.botId,
            { id: receipt.result.ready.sessionId },
            scope.signal,
        );
        return receipt;
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
        return { status: "active" };
    };
}
