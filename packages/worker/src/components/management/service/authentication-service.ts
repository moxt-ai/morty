import type { ClerkGateway } from "../../../gateway/clerk-gateway.ts";
import type { Session } from "../entity/authentication/session.ts";
import type { AgentPairingStorage } from "../storage/agent-pairing-storage.ts";
import type { ConfigurationStorage } from "../storage/configuration-storage.ts";
import type { BindingResult, IdentityStorage, IdentityTransfer } from "../storage/identity-storage.ts";
import type { AnonymousIdentity } from "../storage/identity-storage-common.ts";

type SessionResult =
    | { readonly kind: "authenticated"; readonly session: Session }
    | { readonly kind: "unauthenticated" }
    | { readonly kind: "unavailable" };

interface AuditLogger {
    readonly info: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

export class AuthenticationService {
    private readonly configuration: ConfigurationStorage;
    private readonly clerk: ClerkGateway;
    private readonly identities: IdentityStorage;
    private readonly agentPairings: AgentPairingStorage;
    private readonly logger: AuditLogger;
    private readonly projectId: string | undefined;

    constructor(cx: {
        readonly storages: {
            readonly configuration: ConfigurationStorage;
            readonly identities: IdentityStorage;
            readonly agentPairings: AgentPairingStorage;
        };
        readonly gateways: { readonly clerk: ClerkGateway };
        readonly logger: AuditLogger;
        readonly config: { readonly bindings: { readonly CHAT_PROJECT_ID?: string } };
    }) {
        this.configuration = cx.storages.configuration;
        this.clerk = cx.gateways.clerk;
        this.identities = cx.storages.identities;
        this.agentPairings = cx.storages.agentPairings;
        this.logger = cx.logger;
        this.projectId = cx.config.bindings.CHAT_PROJECT_ID;
    }

    readonly publicConfiguration = (): { readonly publishableKey: string } | null => {
        const configuration = this.configuration.read();
        return configuration === null ? null : { publishableKey: configuration.CLERK_PUBLISHABLE_KEY };
    };

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        if (token.startsWith("mobius_anon_") || token.startsWith("mobius_recovery_")) {
            const userId = await this.identities.authenticateAnonymous(token, signal);
            return userId === null
                ? { kind: "unauthenticated" }
                : { kind: "authenticated", session: { authentication: { kind: "anonymous" }, userId } };
        }
        const configuration = this.configuration.read();
        if (configuration === null) {
            return { kind: "unavailable" };
        }
        const session = await this.clerk.verify(token, configuration, signal);
        if (session === null) {
            return { kind: "unauthenticated" };
        }
        const userId = await this.identities.resolveOrCreateClerk(session.userId, Date.now(), signal);
        if (this.projectId !== undefined && !(await this.identities.ownsProject(userId, this.projectId, signal))) {
            return { kind: "unauthenticated" };
        }
        return {
            kind: "authenticated",
            session: {
                authentication: { kind: "clerk" },
                sessionId: session.sessionId,
                userId,
            },
        };
    };

    readonly createAnonymous = async (
        userId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity> => {
        const identity = await this.identities.createAnonymous(userId, projectId, Date.now(), signal);
        this.logger.info({ event: "anonymous-user-created", userId: identity.userId }, "Identity audit event");
        return identity;
    };

    readonly createPairing = async (
        userId: string,
        botId: string,
        expectedRuntimeId: string | null,
        signal: AbortSignal,
    ) => {
        const ticket = await this.agentPairings.createPairing(userId, botId, expectedRuntimeId, Date.now(), signal);
        this.logger.info({ event: "agent-pairing-issued", userId, botId, expectedRuntimeId }, "Identity audit event");
        return ticket;
    };

    readonly redeemPairing = async (token: string, signal: AbortSignal) => {
        const identity = await this.agentPairings.redeemPairing(token, Date.now(), signal);
        this.logger.info(
            {
                event: "agent-pairing-redeemed",
                outcome: identity === null ? "rejected" : "accepted",
                userId: identity?.userId,
                botId: identity?.botId,
            },
            "Identity audit event",
        );
        return identity;
    };

    readonly createTransfer = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<IdentityTransfer | null> => {
        if (token === undefined) {
            return null;
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        if (userId === null) {
            return null;
        }
        const transfer = await this.identities.createTransfer(userId, Date.now(), signal);
        this.logger.info({ event: "identity-transfer-created", userId }, "Identity audit event");
        return transfer;
    };

    readonly createRecoveryToken = async (token: string | undefined, signal: AbortSignal): Promise<string | null> => {
        if (token === undefined) {
            return null;
        }
        const userId = await this.identities.authenticateAnonymous(token, signal);
        if (userId === null) {
            return null;
        }
        const recoveryToken = await this.identities.createRecoveryToken(userId, Date.now(), signal);
        this.logger.info({ event: "identity-recovery-token-created", userId }, "Identity audit event");
        return recoveryToken;
    };

    readonly redeemTransfer = async (code: string, signal: AbortSignal): Promise<AnonymousIdentity | null> => {
        const identity = await this.identities.redeemTransfer(code, Date.now(), signal);
        this.logger.info(
            {
                event: "identity-transfer-redeemed",
                outcome: identity === null ? "rejected" : "accepted",
                userId: identity?.userId,
            },
            "Identity audit event",
        );
        return identity;
    };

    readonly endRemoteAccess = async (token: string | undefined, signal: AbortSignal) => {
        if (token === undefined) {
            return { kind: "unauthenticated" } as const;
        }
        const result = await this.identities.endRemoteAccess(token, Date.now(), signal);
        this.logger.info(
            {
                event: "remote-access-ended",
                outcome: result.kind,
                userId: result.kind === "unauthenticated" ? undefined : result.userId,
                transferId: result.kind === "ended-transfer" ? result.transferId : undefined,
                credentialId: result.kind === "ended-credential" ? result.credentialId : undefined,
            },
            "Identity audit event",
        );
        return result;
    };

    readonly clerkBinding = async (
        token: string | undefined,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "bound"; readonly userId: string } | { readonly kind: "unbound" } | null> => {
        const clerk = await this.#verifyClerk(token, signal);
        if (clerk === null) {
            return null;
        }
        const userId = await this.identities.clerkBinding(clerk.userId, signal);
        return userId === null ? { kind: "unbound" } : { kind: "bound", userId };
    };

    readonly bindClerk = async (
        clerkToken: string | undefined,
        anonymousToken: string,
        action: "bind" | "discard-local" | "override",
        signal: AbortSignal,
    ): Promise<BindingResult | { readonly kind: "unauthenticated" }> => {
        const clerk = await this.#verifyClerk(clerkToken, signal);
        if (clerk === null) {
            return { kind: "unauthenticated" };
        }
        const localUserId = await this.identities.authenticateAnonymous(anonymousToken, signal);
        if (localUserId === null) {
            return { kind: "invalid-local-user" };
        }
        const result = await this.identities.bindClerk(clerk.userId, localUserId, action, Date.now(), signal);
        this.logger.info(
            { action, clerkUserId: clerk.userId, event: "clerk-binding-resolved", localUserId, outcome: result.kind },
            "Identity audit event",
        );
        return result;
    };

    readonly #verifyClerk = async (token: string | undefined, signal: AbortSignal) => {
        if (token === undefined || token.startsWith("mobius_anon_")) {
            return null;
        }
        const configuration = this.configuration.read();
        return configuration === null ? null : await this.clerk.verify(token, configuration, signal);
    };
}
