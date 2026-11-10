import { nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeIdentifier,
    decodeMessageKind,
    decodeRuntimeStatusEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionStatusChangedEvent,
    type NativeSessionTarget,
    SESSION_CLOSE_NOTICE_KIND,
    type SessionCloseNoticeEvent,
    type SessionStatusChangedEvent,
} from "@morty-build/client/protocol";
import { ComputerManagementError } from "../../management/entity/computer-management.ts";
import type { LocalComputerService } from "../../management/service/local-computer-service.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedBotStorage } from "../../management/storage/managed-bot-storage.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";

const STATUS_LIVENESS_MILLISECONDS = 120_000;
const OPENED_SESSION_CREDENTIAL_SECONDS = 900;
/** The most Sessions one Session list read returns: the Runtime's own bound. */
const LISTED_SESSION_LIMIT = 500;
const RENEWED_SESSION_CREDENTIAL_SECONDS = 600;
/** The Relay issues no Session credential that lasts less than this. */
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
 * each Session the Runtime holds for the computer's owner and that the changes of every such Session follow, including
 * Sessions created later.
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
    throw new ComputerManagementError(
        "NOT_FOUND",
        'This session is not in Morty Recent sessions. If you closed it in Morty, use "Open Session" to import or fork it again.',
        404,
    );
}

/**
 * Morty's Sessions on a computer are the Sessions its Runtime holds: the Runtime alone says which exist, and the cloud
 * keeps no list of its own. A computer has one owner, whom every authorized scope acts as, so each Session the Runtime
 * holds is the scope's.
 */
export class ChatService {
    readonly #identities: IdentityStorage;
    readonly #managedBots: ManagedBotStorage;
    readonly #relay: LocalComputerService;
    readonly #sessionOperations: ManagedSessionOperations | undefined;

    constructor(cx: {
        readonly sessionOperations: ManagedSessionOperations | undefined;
        readonly services: { readonly computers: LocalComputerService };
        readonly storages: {
            readonly identities: IdentityStorage;
            readonly managedBots: ManagedBotStorage;
        };
    }) {
        this.#identities = cx.storages.identities;
        this.#managedBots = cx.storages.managedBots;
        this.#relay = cx.services.computers;
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
            throw new ComputerManagementError("NOT_FOUND", "Your Morty data was not found.", 404);
        }
        return { userId, accessExpiresAt, computerId, signal };
    };

    readonly runtimeConfiguration = async (scope: ChatScope) => {
        await this.localRuntime(scope);
        return {
            runtime: await this.#relay.getChatRuntimeAgents(scope.computerId, scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        return await this.#relay.readRuntimeDiagnostics(scope.computerId, scope.signal);
    };

    readonly networkDiagnostic = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        return {
            mortyRuntimeLatencyMs: await this.#relay.measureRuntimeLatency(scope.computerId, scope.signal),
        };
    };

    readonly setupRuntimes = async (scope: ChatScope) => {
        await this.#bot(scope);
        return { runtimes: await this.#relay.chatRuntimes(scope.computerId, scope.signal) };
    };

    readonly listDirectory = async (scope: ChatScope, directory: string) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new ComputerManagementError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        const listing = await this.#relay.listChatDirectory(scope.computerId, directory, scope.signal);
        return listing;
    };

    readonly #bot = async (scope: ChatScope) => {
        const bot = await this.#managedBots.readBot(scope.userId, scope.signal);
        if (bot === null) {
            throw new ComputerManagementError("NOT_FOUND", "Your Machine was not found.", 404);
        }
        return bot;
    };

    readonly localRuntime = async (scope: ChatScope) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new ComputerManagementError("AGENT_REQUIRED", "Connect an Agent to this Machine first.", 409);
        }
        return bot.configuration;
    };

    /**
     * Runs an operation on an existing Session after every earlier one on that Session has finished, so archival cannot
     * overtake a reopen that has already found the Session.
     */
    readonly #withSession = <Result>(
        scope: ChatScope,
        target: NativeSessionTarget,
        operation: () => Promise<Result>,
    ): Promise<Result> => this.#runSessionOperation(nativeSessionKey(target), scope.signal, operation);

    /** The Runtime's description of a Session it holds; a Session it does not hold is not in Recent sessions. */
    readonly #heldSession = async (scope: ChatScope, target: NativeSessionTarget) =>
        (await this.#relay.queryChatSessions(scope.computerId, [target], scope.signal)).find((session) =>
            sameNativeSession(session.target, target),
        ) ?? notInRecentSessions();

    /** Runs an operation on a Session after every earlier one on that Session has finished. */
    readonly #runSessionOperation = <Result>(
        sessionKey: string,
        signal: AbortSignal,
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        if (this.#sessionOperations === undefined) {
            throw new ComputerManagementError("PROJECT_OBJECT_UNAVAILABLE", "Morty storage is unavailable.", 503);
        }
        return this.#sessionOperations.run(sessionKey, signal, operation);
    };

    readonly #nativeSessionRuntime = async (scope: ChatScope, requestedComputerId: string) => {
        const runtime = await this.localRuntime(scope);
        // The client names the Runtime its native-session identity came from. Discovery and entry identifiers belong to
        // that Runtime and must not be silently redirected to another one.
        if (requestedComputerId !== runtime.computerId) {
            throw new ComputerManagementError(
                "BOT_RUNTIME_FIXED",
                "This Machine is bound to a different Runtime.",
                409,
            );
        }
        return runtime;
    };

    readonly #requireRuntimeAgent = async (scope: ChatScope, harness: string) => {
        const runtime = await this.#relay.getChatRuntimeAgents(scope.computerId, scope.signal);
        if (!runtime.agents.some((agent) => agent.harness === harness)) {
            throw new ComputerManagementError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Machine's Runtime.",
                409,
            );
        }
    };

    /** The Sessions the Runtime holds, most recently updated first. */
    readonly managedSessions = async (scope: ChatScope) => {
        const _runtime = await this.localRuntime(scope);
        const sessions = await this.#relay.listChatSessions(scope.computerId, LISTED_SESSION_LIMIT, scope.signal);
        return {
            sessions: sessions.map((session) => ({
                directory: session.directory,
                directoryLabel: session.directoryLabel,
                prompted: session.prompted,
                target: session.target,
                status: session.status,
                title: session.title,
                updatedAt: session.updatedAt,
            })),
        };
    };

    /**
     * Publishes the current status of each Session the Runtime holds with the following notice, then their activity
     * changes and close notices, until the stream ends. Sessions created or archived while the stream runs need no new
     * stream.
     */
    readonly subscribeManagedSessionStatuses = async (
        scope: ChatScope,
        publish: (event: ManagedSessionEvent) => Promise<void>,
        signal: AbortSignal,
    ): Promise<void> => {
        const _runtime = await this.localRuntime(scope);
        scope.signal.throwIfAborted();
        const socket = await this.#relay.openChatRuntimeHost(scope.computerId, signal);
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
            // Events are published in the order they arrive, after the current statuses.
            let published = Promise.resolve();
            const inOrder = (step: () => Promise<void>): void => {
                published = published.then(step);
                published.catch((cause: unknown) => finish(signal.aborted ? signal.reason : cause));
            };
            const publishEvent = (event: SessionStatusChangedEvent | SessionCloseNoticeEvent): void =>
                inOrder(async () => {
                    if (!settled) {
                        await publish(event);
                    }
                });
            const refreshLiveness = (): void => {
                clearTimeout(liveness);
                liveness = setTimeout(
                    () =>
                        finish(new ComputerManagementError("RELAY_TIMEOUT", "Session status updates timed out.", 504)),
                    STATUS_LIVENESS_MILLISECONDS,
                );
            };
            const aborted = (): void => finish(signal.reason);
            const closed = (): void =>
                finish(new ComputerManagementError("RUNTIME_UNAVAILABLE", "The local Runtime disconnected.", 503));
            const message = (event: MessageEvent): void => {
                try {
                    if (typeof event.data !== "string") {
                        throw new ComputerManagementError(
                            "RELAY_INVALID_RESPONSE",
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
                        publishEvent(decodeSessionCloseNoticeEvent(event.data));
                        return;
                    }
                    if (kind === "session.status.changed") {
                        publishEvent(decodeSessionStatusChangedEvent(event.data));
                    }
                } catch (cause) {
                    finish(
                        cause instanceof ComputerManagementError
                            ? cause
                            : new ComputerManagementError(
                                  "RELAY_INVALID_RESPONSE",
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
            throw new ComputerManagementError("AGENT_REQUIRED", "Choose a connected harness.", 409);
        }
        await this.#requireRuntimeAgent(scope, draft.harness);
        const discovered = await this.#relay.discoverChatAgentSettings(
            scope.computerId,
            { computerId: bot.configuration.computerId, ...draft },
            scope.signal,
        );
        return { settings: discovered };
    };

    readonly openChat = async (scope: ChatScope, input: OpenChatInput) => {
        const bot = await this.#bot(scope);
        if (bot.configuration === null) {
            throw new ComputerManagementError("AGENT_REQUIRED", "Connect your local agent to start chatting.", 409);
        }
        const access =
            "conversationKey" in input
                ? await this.#openNewChat(scope, input)
                : await this.#withSession(scope, input, () => this.#reopenManagedSession(scope, input));
        return access;
    };

    /**
     * First send creates a harness Session under an operation identity derived from the draft. The Runtime keeps the
     * creation's receipt under it, so a retry after a lost answer opens the Session the first attempt created instead
     * of creating another.
     */
    readonly #openNewChat = async (scope: ChatScope, input: NewChatInput) => {
        await this.#requireRuntimeAgent(scope, input.harness);
        const session = {
            operationId: await chatOperationId(scope, input.conversationKey),

            computerId: scope.computerId,
            harness: input.harness,
            workspaceRef: input.workspaceRef,
        };
        const ready = await this.#relay.createChatSession(
            scope.computerId,
            { ...session, configurations: input.configurations },
            scope.signal,
        );
        return await this.#relay.createdChatSessionAccess(
            scope.computerId,
            { ...session, target: ready.target },
            ready,
            sessionCredentialLifetime(OPENED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.signal,
        );
    };

    readonly #reopenManagedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        const metadata = await this.#heldSession(scope, target);
        return await this.#relay.openChatSession(
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

    /** Issues a credential for a Session the Runtime holds. */
    readonly nativeSessionAccess = async (scope: ChatScope, target: NativeSessionTarget) => {
        const _runtime = await this.localRuntime(scope);
        const session = await this.#heldSession(scope, target);
        return await this.#relay.nativeSessionAccess(
            scope.computerId,
            session.target,
            sessionCredentialLifetime(RENEWED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.signal,
        );
    };

    readonly managedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        await this.#bot(scope);
        return await this.#withSession(scope, target, async () => {
            const runtime = await this.localRuntime(scope);
            const session = await this.#heldSession(scope, target);
            const restored = await this.#relay.readChatSession(scope.computerId, runtime, target, scope.signal);
            if (!sameNativeSession(restored.ready.target, session.target)) {
                throw new ComputerManagementError(
                    "RELAY_INVALID_RESPONSE",
                    "Morty restored a different managed Session.",
                    502,
                );
            }
            return restored;
        });
    };

    /**
     * Archives the Session on the Runtime, which closes it and forgets it, so it leaves the list. It answers only once
     * the Runtime no longer holds the Session, and fails as the Runtime does otherwise, so a Session the Runtime still
     * holds stays listed. Archiving a Session the Runtime does not hold succeeds.
     */
    readonly archiveManagedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        const _runtime = await this.localRuntime(scope);
        return await this.#withSession(scope, target, async () => ({
            target: await this.#relay.archiveChatSession(scope.computerId, target, scope.signal),
        }));
    };

    readonly nativeSessions = async (scope: ChatScope, requestedComputerId: string, input: NativeListInput) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        const result = await this.#relay.nativeSessions(scope.computerId, input, scope.signal);
        if (result.action !== "list") {
            throw new ComputerManagementError(
                "RELAY_INVALID_RESPONSE",
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
                : await this.#relay.getChatRuntimeAgents(scope.computerId, scope.signal);
        const agent = runtime?.agents.find((item) => item.harness === harness);
        if (runtime === undefined || agent === undefined) {
            throw new ComputerManagementError("HARNESS_UNAVAILABLE", "The handoff harness is unavailable.", 409);
        }
        const found = await this.#relay.findNativeSessionBySessionId(
            scope.computerId,
            {
                harness: agent.harness,
                directory: ".",
                sessionId: sessionId,
            },
            scope.signal,
        );
        const entry = found.entry;
        const result = await this.#relay.nativeSessions(
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
            throw new ComputerManagementError("IMPORT_UNAVAILABLE", "The original session could not be opened.", 409);
        }
        return { harness: agent.harness, result, entry };
    };

    readonly previewNativeSession = async (
        scope: ChatScope,
        requestedComputerId: string,
        input: NativePreviewInput,
    ) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        const events = await this.#relay.previewRuntimeNativeEvents(
            scope.computerId,
            { harness: input.harness, sessionId: input.sessionId },
            input.directory,
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
        const result = await this.#relay.nativeSessions(
            scope.computerId,
            { ...input, sessionId, action: "import" },
            scope.signal,
        );
        if (result.action !== "import") {
            throw new ComputerManagementError(
                "IMPORT_UNAVAILABLE",
                "This agent cannot import the selected local session.",
                409,
            );
        }
        return result;
    };

    readonly recoverableNativeFork = async (
        scope: ChatScope,
        requestedComputerId: string,
        operationId: string,
        input: NativePreviewInput,
    ) => {
        const _runtime = await this.#nativeSessionRuntime(scope, requestedComputerId);
        // Operation identity belongs to this user and Machine, even when they share a Relay Project.
        const scopedOperationId = await scopedNativeForkOperationId(
            scope.computerId,
            `${scope.userId}\u0000fork\u0000${operationId}`,
        );
        return await this.#relay.forkNativeSession(scope.computerId, scopedOperationId, input, scope.signal);
    };

    readonly configureBot = async (scope: ChatScope, input: ConfigureBotInput) => {
        await this.#bot(scope);
        if (input.computerId !== scope.computerId) {
            throw new ComputerManagementError("BOT_RUNTIME_FIXED", "This chat belongs to a different computer.", 409);
        }
        await this.#requireRuntimeAgent(scope, input.harness);
        await this.#relay.discoverChatAgentSettings(scope.computerId, { ...input, workspaceRef: "." }, scope.signal);
        const result = await this.#managedBots.configureBot(
            scope.userId,
            { computerId: decodeIdentifier(input.computerId) },
            Date.now(),
            scope.signal,
        );
        if (result !== "configured") {
            if (result === "runtime-mismatch") {
                throw new ComputerManagementError(
                    "BOT_RUNTIME_FIXED",
                    "Create a new Machine to pair a different Runtime.",
                    409,
                );
            }
            throw new ComputerManagementError("NOT_FOUND", "Your Machine was not found.", 404);
        }
        return { status: "active" };
    };
}
