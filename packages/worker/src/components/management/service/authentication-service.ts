import type { ClerkGateway } from "../../../gateway/clerk-gateway.ts";
import type { Session } from "../entity/authentication/session.ts";
import type { ConfigurationStorage } from "../storage/configuration-storage.ts";
import type {
    AnonymousIdentity,
    BindingResult,
    IdentityStorage,
    IdentityTransfer,
} from "../storage/identity-storage.ts";

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
    private readonly logger: AuditLogger;

    constructor(cx: {
        readonly storages: { readonly configuration: ConfigurationStorage; readonly identities: IdentityStorage };
        readonly gateways: { readonly clerk: ClerkGateway };
        readonly logger: AuditLogger;
    }) {
        this.configuration = cx.storages.configuration;
        this.clerk = cx.gateways.clerk;
        this.identities = cx.storages.identities;
        this.logger = cx.logger;
    }

    readonly publicConfiguration = (): { readonly publishableKey: string } | null => {
        const configuration = this.configuration.read();
        return configuration === null ? null : { publishableKey: configuration.CLERK_PUBLISHABLE_KEY };
    };

    readonly session = async (token: string | undefined, signal: AbortSignal): Promise<SessionResult> => {
        if (token === undefined) {
            return { kind: "unauthenticated" };
        }
        if (token.startsWith("mobius_anon_v1_")) {
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
        return {
            kind: "authenticated",
            session: {
                authentication: { kind: "clerk" },
                sessionId: session.sessionId,
                userId: await this.identities.resolveOrCreateClerk(session.userId, Date.now(), signal),
            },
        };
    };

    readonly createAnonymous = async (signal: AbortSignal): Promise<AnonymousIdentity> => {
        const identity = await this.identities.createAnonymous(Date.now(), signal);
        this.logger.info({ event: "anonymous-user-created", userId: identity.userId }, "Identity audit event");
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
        this.logger.info(
            { event: "identity-transfer-created", expiresAt: transfer.expiresAt, userId },
            "Identity audit event",
        );
        return transfer;
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
        if (token === undefined || token.startsWith("mobius_anon_v1_")) {
            return null;
        }
        const configuration = this.configuration.read();
        return configuration === null ? null : await this.clerk.verify(token, configuration, signal);
    };
}
