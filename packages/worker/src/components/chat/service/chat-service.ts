import { NativeSessionMap, nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeIdentifier,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionStatusChangedEvent,
    type NativeSessionTarget,
    SESSION_CLOSE_NOTICE_KIND,
    type SessionCloseNoticeEvent,
    type SessionReadyEvent,
    type SessionStatusChangedEvent,
} from "@morty-build/client/protocol";
import type { PlatformProjectGateway } from "../../../gateway/platform-project-gateway.ts";
import { PlatformProjectError } from "../../management/entity/platform-project.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";
import type { ManagedSessionStorage } from "../storage/managed-session-storage.ts";

const STATUS_LIVENESS_MILLISECONDS = 120_000;
const OPENED_SESSION_CREDENTIAL_SECONDS = 900;
const RENEWED_SESSION_CREDENTIAL_SECONDS = 600;
/** The Platform issues no Session credential that lasts less than this. */
export const MINIMUM_SESSION_CREDENTIAL_SECONDS = 60;

/**
 * A Session credential lasts `usualSeconds`, but no longer than the access that requests it, so it ends when that
 * access expires. Access that ends sooner than the shortest credential is refused before issuing.
 */
function sessionCredentialLifetime(usualSeconds: number, accessExpiresAt: number | null): number {
    if (accessExpiresAt === null) {
        return usualSeconds;
    }
    const remainingSeconds = Math.floor((accessExpiresAt - Date.now()) / 1000);
    return Math.max(MINIMUM_SESSION_CREDENTIAL_SECONDS, Math.min(usualSeconds, remainingSeconds));
}

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
    /** When the requesting access ends, if it does; the Session credentials it obtains end no later. */
    readonly accessExpiresAt: number | null;
    readonly computerId: string;
    readonly signal: AbortSignal;
};

type NativeListInput = {
    readonly action: "list";
    readonly harness: string;
    readonly directory: string;
    readonly cursor: string | null;
};
type NativeEntryInput = {
    readonly harness: string;
    readonly directory: string;
};
type NativePreviewInput = Omit<NativeEntryInput, never> & { readonly sessionId: string };
type NewChatInput = {
    readonly harness: string;
    readonly conversationKey: string;
    readonly configurations: readonly {
        readonly booleanValue: boolean;
        readonly configId: string;
        readonly value: string;
        readonly valueType: "select" | "boolean";
    }[];
    readonly workspaceRef: string;
};
type OpenChatInput = NativeSessionTarget | NewChatInput;
type ConfigureBotInput = {
    readonly computerId: string;
    readonly harness: string;
};
type ManagedSessionArchival = { readonly close: "confirmed" | "unconfirmed" };

async function chatOperationId(scope: ChatScope, key: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([scope.computerId, scope.userId, "create", key])),
    );
    return `create_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function scopedNativeForkOperationId(computerId: string, key: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${computerId}\u0000${key}`));
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
    readonly target: NativeSessionTarget;

    private constructor(scope: ChatScope, target: NativeSessionTarget) {
        this.scope = scope;
        this.target = target;
    }

    static readonly find = async (
        sessions: ManagedSessionStorage,
        scope: ChatScope,
        target: NativeSessionTarget,
    ): Promise<OwnedManagedSession | null> =>
        (await sessions.ownsSession(scope.computerId, scope.userId, target, scope.signal))
            ? new OwnedManagedSession(scope, target)
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
        requester: { readonly userId: string; readonly accessExpiresAt: number | null },
        computerId: string,
        signal: AbortSignal,
    ): Promise<ChatScope> => {
        const { userId, accessExpiresAt } = requester;
        const ownsProject = await this.#identities.ownsProject(userId, computerId, signal);
        if (!ownsProject) {
            throw new PlatformProjectError("NOT_FOUND", "Your Morty data was not found.", 404);
        }
        return { userId, accessExpiresAt, computerId, signal };
    };

    readonly runtimeConfiguration = async (scope: ChatScope) => {
        await this.localRuntime(scope);
        return {
            runtime: await this.#platform.getChatRuntimeAgents(scope.computerId, scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        return await this.#platform.readRuntimeDiagnostics(scope.computerId, scope.signal);
    };

    readonly networkDiagnostic = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        const [mortyRelayLatencyMs, relayRuntimeLatencyMs] = await Promise.all([
            this.#platform.measureRelayLatency(scope.computerId, scope.signal),
            this.#platform.measureRuntimeLatency(scope.computerId, scope.signal),
        ]);
        return {
            relayOrigin: this.#platform.configuration().origin,
            relayRuntimeLatencyMs,
            mortyRelayLatencyMs,
        };
    };

    readonly setupRuntimes = async (scope: ChatScope) => {
        await this.#bot(scope);
        return { runtimes: await this.#platform.chatRuntimes(scope.computerId, scope.signal) };
    };

    readonly listDirectory = async (scope: ChatScope, directory: string) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        const listing = await this.#platform.listChatDirectory(scope.computerId, directory, scope.signal);
        return listing;
    };

    readonly #bot = async (scope: ChatScope) => {
        const bot = await this.#managedBots.readBot(scope.userId, scope.signal);
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
        target: NativeSessionTarget,
        notOwned: () => Result,
        operation: (session: OwnedManagedSession) => Promise<Result>,
    ): Promise<Result> =>
        this.#runSessionOperation(nativeSessionKey(target), scope.signal, async () => {
            const session = await OwnedManagedSession.find(this.#chatSessions, scope, target);
            return session === null ? notOwned() : await operation(session);
        });

    /** Runs an operation on a Session after every earlier one on that Session has finished. */
    readonly #runSessionOperation = <Result>(
        sessionKey: string,
        signal: AbortSignal,
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        if (this.#sessionOperations === undefined) {
            throw new PlatformProjectError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
        }
        return this.#sessionOperations.run(sessionKey, signal, operation);
    };

    readonly #nativeSessionRuntime = async (scope: ChatScope, requestedComputerId: string) => {
        const runtime = await this.localRuntime(scope);
        // The client names the Runtime its native-session identity came from. Discovery and entry identifiers belong to
        // that Runtime and must not be silently redirected to another one.
        if (requestedComputerId !== runtime.computerId) {
            throw new PlatformProjectError("BOT_RUNTIME_FIXED", "This Machine is bound to a different Runtime.", 409);
        }
        return runtime;
    };

    readonly #requireRuntimeAgent = async (scope: ChatScope, harness: string) => {
        const runtime = await this.#platform.getChatRuntimeAgents(scope.computerId, scope.signal);
        if (!runtime.agents.some((agent) => agent.harness === harness)) {
            throw new PlatformProjectError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Machine's Runtime.",
                409,
            );
        }
    };

    readonly managedSessions = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        const owned = await this.#chatSessions.list(scope.computerId, scope.userId, scope.signal);
        if (owned.length === 0) {
            return { sessions: [] };
        }
        const metadata = await this.#platform.queryChatSessions(
            scope.computerId,
            owned.map((session) => session.target),
            scope.signal,
        );
        const byId = new NativeSessionMap<(typeof metadata)[number]>();
        for (const session of metadata) {
            byId.set(session.target, session);
        }
        // The Runtime alone says which Sessions exist; an owner record says only whose they are. A record whose Session
        // the Runtime does not hold, such as a start that never reached it, is not a conversation.
        return {
            sessions: owned.flatMap((session) => {
                const details = byId.get(session.target);
                if (details === undefined) {
                    return [];
                }
                return [
                    {
                        ...session,
                        createdAt: new Date(session.createdAt).toISOString(),
                        directory: details.directory,
                        directoryLabel: details.directoryLabel,
                        prompted: details.prompted,
                        target: { harness: details.harness, sessionId: details.sessionId },
                        status: details.status,
                        title: details.title,
                        updatedAt: details.updatedAt,
                    },
                ];
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
        publish: (event: ManagedSessionEvent) => Promise<void>,
        signal: AbortSignal,
    ): Promise<void> => {
        const _runtime = await this.localRuntime(scope);
        scope.signal.throwIfAborted();
        const socket = await this.#platform.openChatRuntimeHost(scope.computerId, signal);
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
                        scope.computerId,
                        scope.userId,
                        event.target,
                        signal,
                    );
                    if (owned && !settled) {
                        await publish(event);
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
                            "Morty returned an invalid Session status event.",
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
                                  "Morty returned an invalid Session status event.",
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
                    await publish({
                        kind: MANAGED_SESSION_STATUSES_FOLLOWING_KIND,
                        sessions: "owned",
                        statuses: sessions.map((session) => ({ target: session.target, status: session.status })),
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
        draft: { readonly harness: string; readonly workspaceRef: string },
    ) => {
        const bot = await this.#bot(scope);
        if (bot?.configuration === null || bot === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        await this.#requireRuntimeAgent(scope, draft.harness);
        const discovered = await this.#platform.discoverChatAgentSettings(
            scope.computerId,
            { computerId: bot.configuration.computerId, ...draft },
            scope.signal,
        );
        return { settings: discovered };
    };

    readonly openChat = async (scope: ChatScope, input: OpenChatInput) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new PlatformProjectError("AGENT_REQUIRED", "Connect your local agent to start chatting.", 409);
        }
        const access =
            "conversationKey" in input
                ? await this.#openNewChat(scope, input)
                : await this.#withOwnedManagedSession(
                      scope,
                      await this.#ownedNativeSessionTarget(scope, input),
                      notInRecentSessions,
                      (session) => this.#reopenManagedSession(session),
                  );
        return access;
    };

    /**
     * First send creates a harness Session. Its operation identity permits recovery without inventing a conversation
     * identity. A failed retry never removes ownership established by a previous attempt.
     */
    readonly #openNewChat = async (scope: ChatScope, input: NewChatInput) => {
        await this.#requireRuntimeAgent(scope, input.harness);
        const session = {
            operationId: await chatOperationId(scope, input.conversationKey),

            computerId: scope.computerId,
            harness: input.harness,
            workspaceRef: input.workspaceRef,
        };
        // Serialize creation, initial configuration, and ownership recovery for the same operation.
        const ready = await this.#runSessionOperation(session.operationId, scope.signal, async () => {
            let created: SessionReadyEvent;
            try {
                created = await this.#platform.createChatSession(
                    scope.computerId,
                    { ...session, configurations: input.configurations },
                    scope.signal,
                );
            } catch (cause) {
                scope.signal.throwIfAborted();
                if (cause instanceof PlatformProjectError && cause.status >= 500) {
                    // Recover ownership after response loss by reading a receipt, never by issuing another create.
                    try {
                        const recovered = await this.#platform.readChatSessionCreation(
                            scope.computerId,
                            session.operationId,
                            scope.signal,
                        );
                        if (
                            recovered !== null &&
                            recovered.harness === input.harness &&
                            recovered.directory === input.workspaceRef
                        ) {
                            await this.#chatSessions.recordCreated(
                                scope.computerId,
                                scope.userId,
                                recovered.target,
                                scope.signal,
                            );
                        }
                    } catch {
                        scope.signal.throwIfAborted();
                        // The original failure remains authoritative; retry keeps the same operation identity.
                    }
                }
                throw cause;
            }
            await this.#chatSessions.recordCreated(scope.computerId, scope.userId, created.target, scope.signal);
            return created;
        });
        return await this.#withOwnedManagedSession(scope, ready.target, notInRecentSessions, () =>
            this.#platform.createdChatSessionAccess(
                scope.computerId,
                { ...session, target: ready.target },
                ready,
                sessionCredentialLifetime(OPENED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
                scope.signal,
            ),
        );
    };

    readonly #reopenManagedSession = async ({ scope, target }: OwnedManagedSession) => {
        const metadata = (await this.#platform.queryChatSessions(scope.computerId, [target], scope.signal)).find(
            (session) => sameNativeSession(session.target, target),
        );
        if (metadata === undefined) {
            throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
        }
        return await this.#platform.openChatSession(
            scope.computerId,
            {
                target,

                computerId: scope.computerId,
                harness: metadata.harness,
                workspaceRef: metadata.directory,
            },
            sessionCredentialLifetime(OPENED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.signal,
        );
    };

    readonly nativeSessionAccess = async (scope: ChatScope, target: NativeSessionTarget) => {
        const sessionTarget = await this.#ownedNativeSessionTarget(scope, target);
        const session = await OwnedManagedSession.find(this.#chatSessions, scope, sessionTarget);
        if (session === null) {
            throw new PlatformProjectError("NOT_FOUND", "The session was not found.", 404);
        }
        const _runtime = await this.localRuntime(scope);
        return await this.#platform.nativeSessionAccess(
            scope.computerId,
            session.target,
            sessionCredentialLifetime(RENEWED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.signal,
        );
    };

    readonly #ownedNativeSessionTarget = async (
        scope: ChatScope,
        target: NativeSessionTarget,
    ): Promise<NativeSessionTarget> => {
        return (
            (await this.#chatSessions.findNative(scope.computerId, scope.userId, target, scope.signal)) ??
            notInRecentSessions()
        );
    };

    readonly managedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        await this.#bot(scope);
        const sessionTarget = await this.#ownedNativeSessionTarget(scope, target);
        return await this.#withOwnedManagedSession(scope, sessionTarget, notInRecentSessions, async (session) => {
            const runtime = await this.localRuntime(scope);
            const restored = await this.#platform.readChatSession(scope.computerId, runtime, target, scope.signal);
            if (!sameNativeSession(restored.ready.target, session.target)) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Morty restored a different managed Session.",
                    502,
                );
            }
            return restored;
        });
    };

    readonly archiveManagedSession = async (
        scope: ChatScope,
        target: NativeSessionTarget,
    ): Promise<ManagedSessionArchival> => {
        const sessionTarget = await this.#chatSessions.findNative(scope.computerId, scope.userId, target, scope.signal);
        if (sessionTarget === null) {
            return { close: "unconfirmed" };
        }
        return await this.#withOwnedManagedSession<ManagedSessionArchival>(
            scope,
            sessionTarget,
            () => ({ close: "unconfirmed" }),
            async (session) => {
                const _runtime = await this.localRuntime(scope);
                let close: ManagedSessionArchival["close"] = "unconfirmed";
                try {
                    await this.#platform.closeChatSession(scope.computerId, session.target, scope.signal);
                    close = "confirmed";
                } catch {
                    scope.signal.throwIfAborted();
                }
                // Archival stays available to an offline Runtime, but does not prove its process stopped.
                await this.#chatSessions.archive(scope.computerId, scope.userId, session.target, scope.signal);
                return { close };
            },
        );
    };

    readonly nativeSessions = async (scope: ChatScope, requestedComputerId: string, input: NativeListInput) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        const result = await this.#platform.nativeSessions(scope.computerId, input, scope.signal);
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
                : await this.#platform.getChatRuntimeAgents(scope.computerId, scope.signal);
        const agent = runtime?.agents.find((item) => item.harness === harness);
        if (runtime === undefined || agent === undefined) {
            throw new PlatformProjectError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        const found = await this.#platform.findNativeSessionBySessionId(
            scope.computerId,
            {
                harness: agent.harness,
                directory: ".",
                sessionId: sessionId,
            },
            scope.signal,
        );
        const entry = found.entry;
        const result = await this.#platform.nativeSessions(
            scope.computerId,
            {
                action: "import",
                harness: agent.harness,
                directory: entry.directory,
                sessionId: entry.sessionId,
            },
            scope.signal,
        );
        if (result.action !== "import") {
            throw new PlatformProjectError("IMPORT_UNAVAILABLE", "The original session could not be opened.", 409);
        }
        const stored = { harness: agent.harness, result, entry };
        await this.#chatSessions.include(scope.computerId, scope.userId, result.target, scope.signal);
        return stored;
    };

    readonly previewNativeSession = async (
        scope: ChatScope,
        requestedComputerId: string,
        input: NativePreviewInput,
    ) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        const events = await this.#platform.previewRuntimeNativeEvents(
            scope.computerId,
            { harness: input.harness, sessionId: input.sessionId },
            {
                harness: input.harness,
                directory: input.directory,
            },
            { cursor: null, eventLimit: 200 },
            scope.signal,
        );
        return events;
    };

    readonly importNativeSession = async (
        scope: ChatScope,
        requestedComputerId: string,
        sessionId: string,
        input: NativeEntryInput,
    ) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        const result = await this.#platform.nativeSessions(
            scope.computerId,
            { ...input, sessionId, action: "import" },
            scope.signal,
        );
        if (result.action !== "import") {
            throw new PlatformProjectError(
                "IMPORT_UNAVAILABLE",
                "This agent cannot import the selected local session.",
                409,
            );
        }
        const target = await this.#readNativeTarget(scope, result.ready);
        await this.#chatSessions.include(scope.computerId, scope.userId, target, scope.signal);
        return result;
    };

    readonly recoverableNativeFork = async (
        scope: ChatScope,
        requestedComputerId: string,
        operationId: string,
        input: NativePreviewInput,
    ) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        // Operation identity belongs to this user and Machine, even when they share a Platform Project.
        const scopedOperationId = await scopedNativeForkOperationId(
            scope.computerId,
            `${scope.userId}\u0000fork\u0000${operationId}`,
        );
        const receipt = await this.#platform.forkNativeSession(
            scope.computerId,
            scopedOperationId,
            input,
            scope.signal,
        );
        const target = await this.#readNativeTarget(scope, receipt.result.ready);
        await this.#chatSessions.recordCreated(scope.computerId, scope.userId, target, scope.signal);
        await this.#ownedNativeSessionTarget(scope, target);
        return receipt;
    };

    readonly #readNativeTarget = async (scope: ChatScope, ready: SessionReadyEvent): Promise<NativeSessionTarget> => {
        const entries = await this.#platform.queryChatSessions(scope.computerId, [ready.target], scope.signal);
        const entry = entries.find(
            (entry) => sameNativeSession(entry.target, ready.target) && entry.harness === ready.harness,
        );
        if (entry === undefined) {
            throw new PlatformProjectError(
                "PLATFORM_INVALID_RESPONSE",
                "Morty could not identify the native Session.",
                502,
            );
        }
        return { harness: entry.harness, sessionId: entry.sessionId };
    };

    readonly configureBot = async (scope: ChatScope, input: ConfigureBotInput) => {
        await this.#bot(scope);
        if (input.computerId !== scope.computerId) {
            throw new PlatformProjectError("BOT_RUNTIME_FIXED", "This chat belongs to a different computer.", 409);
        }
        await this.#requireRuntimeAgent(scope, input.harness);
        await this.#platform.discoverChatAgentSettings(scope.computerId, { ...input, workspaceRef: "." }, scope.signal);
        const result = await this.#managedBots.configureBot(
            scope.userId,
            { computerId: decodeIdentifier(input.computerId) },
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
