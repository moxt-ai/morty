import { nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget, SessionAccessHolder } from "@morty-build/client/protocol";
import { ComputerManagementError } from "../../management/entity/computer-management.ts";
import { computerRevoked } from "../../management/entity/computer-pairing.ts";
import type { LocalComputerService } from "../../management/service/local-computer-service.ts";
import type { IdentityStorage } from "../../management/storage/identity-storage.ts";
import type { ManagedSessionOperations } from "../infra/managed-session-operations.ts";

const OPENED_SESSION_CREDENTIAL_SECONDS = 900;
/** The most Sessions one Session list read returns: the Computer's own bound. */
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

export type ChatScope = {
    readonly userId: string;
    /** When the requesting access ends, if it does; the Session credentials it obtains end no later. */
    readonly accessExpiresAt: number | null;
    /** Whose access the request carries; the Session credentials it obtains last only while that access holds. */
    readonly holder: SessionAccessHolder;
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
type AgentSetupInput = {
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
 * Morty's Sessions on a computer are the Sessions its Computer holds: the Computer alone says which exist, and the cloud
 * keeps no list of its own. A computer has one owner, whom every authorized scope acts as, so each Session the Computer
 * holds is the scope's.
 */
export class ChatService {
    readonly #identities: IdentityStorage;
    readonly #relay: LocalComputerService;
    readonly #sessionOperations: ManagedSessionOperations | undefined;

    constructor(cx: {
        readonly sessionOperations: ManagedSessionOperations | undefined;
        readonly services: { readonly computers: LocalComputerService };
        readonly storages: { readonly identities: IdentityStorage };
    }) {
        this.#identities = cx.storages.identities;
        this.#relay = cx.services.computers;
        this.#sessionOperations = cx.sessionOperations;
    }

    readonly authorize = async (
        requester: {
            readonly userId: string;
            readonly accessExpiresAt: number | null;
            readonly holder: SessionAccessHolder;
        },
        computerId: string,
        signal: AbortSignal,
    ): Promise<ChatScope> => {
        const { userId, accessExpiresAt, holder } = requester;
        const ownsProject = await this.#identities.ownsProject(userId, computerId, signal);
        if (!ownsProject) {
            throw new ComputerManagementError("NOT_FOUND", "Your Morty data was not found.", 404);
        }
        return { userId, accessExpiresAt, holder, computerId, signal };
    };

    readonly computerConfiguration = async (scope: ChatScope) => {
        await this.#requirePairedComputer(scope);
        return {
            computer: await this.#relay.getChatComputerAgents(scope.computerId, scope.signal),
        };
    };

    readonly daemonDiagnostics = async (scope: ChatScope) => {
        await this.#requirePairedComputer(scope);
        return await this.#relay.readComputerDiagnostics(scope.computerId, scope.signal);
    };

    readonly networkDiagnostic = async (scope: ChatScope) => {
        await this.#requirePairedComputer(scope);
        return { computerLatencyMs: await this.#relay.measureComputerLatency(scope.computerId, scope.signal) };
    };

    readonly setupComputers = async (scope: ChatScope) => ({
        computers: await this.#relay.chatComputers(scope.computerId, scope.signal),
    });

    readonly listDirectory = async (scope: ChatScope, directory: string) => {
        await this.#requirePairedComputer(scope);
        const listing = await this.#relay.listChatDirectory(scope.computerId, directory, scope.signal);
        return listing;
    };

    /**
     * Requires the computer to have a paired Computer, as the Relay records it. Until it has one the Machine needs an
     * Agent connected; once its Computer was revoked it needs setup run again.
     */
    readonly #requirePairedComputer = async (scope: ChatScope): Promise<void> => {
        const pairing = await this.#relay.readComputerPairing(scope.computerId, scope.signal);
        switch (pairing) {
            case "paired":
                return;
            case "unpaired":
                throw new ComputerManagementError("AGENT_REQUIRED", "Connect an Agent to this Machine first.", 409);
            case "revoked":
                throw computerRevoked();
            default:
                return pairing satisfies never;
        }
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

    /** The Computer's description of a Session it holds; a Session it does not hold is not in Recent sessions. */
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

    readonly #requireNativeSessionComputer = async (scope: ChatScope, requestedComputerId: string) => {
        // The client names the Computer its native-session identity came from. Discovery and entry identifiers belong to
        // that Computer and must not be silently redirected to another one.
        if (requestedComputerId !== scope.computerId) {
            throw new ComputerManagementError("BOT_COMPUTER_FIXED", "This request names a different computer.", 409);
        }
        await this.#requirePairedComputer(scope);
    };

    readonly #requireComputerAgent = async (scope: ChatScope, harness: string) => {
        const computer = await this.#relay.getChatComputerAgents(scope.computerId, scope.signal);
        if (!computer.agents.some((agent) => agent.harness === harness)) {
            throw new ComputerManagementError(
                "AGENT_UNAVAILABLE",
                "Choose an agent provided by this Machine's Runtime.",
                409,
            );
        }
    };

    /** The Sessions the Computer holds, most recently updated first. */
    readonly managedSessions = async (scope: ChatScope) => {
        await this.#requirePairedComputer(scope);
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

    /** The settings a new Session of this Agent starts with in the draft's directory. */
    readonly agentSettings = async (
        scope: ChatScope,
        draft: { readonly harness: string; readonly workspaceRef: string },
    ) => {
        await this.#requirePairedComputer(scope);
        await this.#requireComputerAgent(scope, draft.harness);
        const discovered = await this.#relay.discoverChatAgentSettings(
            scope.computerId,
            { computerId: scope.computerId, ...draft },
            scope.signal,
        );
        return { settings: discovered };
    };

    readonly openChat = async (scope: ChatScope, input: OpenChatInput) => {
        await this.#requirePairedComputer(scope);
        const access =
            "conversationKey" in input
                ? await this.#openNewChat(scope, input)
                : await this.#withSession(scope, input, () => this.#reopenManagedSession(scope, input));
        return access;
    };

    /**
     * First send creates a harness Session under an operation identity derived from the draft. The Computer keeps the
     * creation's receipt under it, so a retry after a lost answer opens the Session the first attempt created instead
     * of creating another.
     */
    readonly #openNewChat = async (scope: ChatScope, input: NewChatInput) => {
        await this.#requireComputerAgent(scope, input.harness);
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
            scope.holder,
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
            scope.holder,
            scope.signal,
        );
    };

    /** Issues a credential for a Session the Computer holds. */
    readonly nativeSessionAccess = async (scope: ChatScope, target: NativeSessionTarget) => {
        await this.#requirePairedComputer(scope);
        const session = await this.#heldSession(scope, target);
        return await this.#relay.nativeSessionAccess(
            scope.computerId,
            session.target,
            sessionCredentialLifetime(RENEWED_SESSION_CREDENTIAL_SECONDS, scope.accessExpiresAt),
            scope.holder,
            scope.signal,
        );
    };

    readonly managedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        return await this.#withSession(scope, target, async () => {
            await this.#requirePairedComputer(scope);
            const session = await this.#heldSession(scope, target);
            const restored = await this.#relay.readChatSession(scope.computerId, target, scope.signal);
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
     * Archives the Session on the Computer, which closes it and forgets it, so it leaves the list. It answers only once
     * the Computer no longer holds the Session, and fails as the Computer does otherwise, so a Session the Computer still
     * holds stays listed. Archiving a Session the Computer does not hold succeeds.
     */
    readonly archiveManagedSession = async (scope: ChatScope, target: NativeSessionTarget) => {
        await this.#requirePairedComputer(scope);
        return await this.#withSession(scope, target, async () => ({
            target: await this.#relay.archiveChatSession(scope.computerId, target, scope.signal),
        }));
    };

    readonly nativeSessions = async (scope: ChatScope, requestedComputerId: string, input: NativeListInput) => {
        await this.#requireNativeSessionComputer(scope, requestedComputerId);
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
        const computer =
            (await this.#relay.readComputerPairing(scope.computerId, scope.signal)) === "paired"
                ? await this.#relay.getChatComputerAgents(scope.computerId, scope.signal)
                : undefined;
        const agent = computer?.agents.find((item) => item.harness === harness);
        if (computer === undefined || agent === undefined) {
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
        await this.#requireNativeSessionComputer(scope, requestedComputerId);
        const events = await this.#relay.previewComputerNativeEvents(
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
        await this.#requireNativeSessionComputer(scope, requestedComputerId);
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
        await this.#requireNativeSessionComputer(scope, requestedComputerId);
        // Operation identity belongs to this user and Machine, even when they share a Relay Project.
        const scopedOperationId = await scopedNativeForkOperationId(
            scope.computerId,
            `${scope.userId}\u0000fork\u0000${operationId}`,
        );
        return await this.#relay.forkNativeSession(scope.computerId, scopedOperationId, input, scope.signal);
    };

    /**
     * Setup's check that the computer's paired Computer offers `harness` and can open its settings in the default
     * working directory. It records nothing: whether the Machine has a Runtime is the Relay's pairing.
     */
    readonly verifyAgent = async (scope: ChatScope, input: AgentSetupInput) => {
        if (input.computerId !== scope.computerId) {
            throw new ComputerManagementError("BOT_COMPUTER_FIXED", "This request names a different computer.", 409);
        }
        await this.#requireComputerAgent(scope, input.harness);
        await this.#relay.discoverChatAgentSettings(scope.computerId, { ...input, workspaceRef: "." }, scope.signal);
        return { status: "active" };
    };
}
