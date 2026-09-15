import type { ClerkGateway } from "../../../../gateway/clerk-gateway.ts";
import type { AuthenticationConfiguration } from "../../../management/storage/authentication-configuration.ts";
import type { HumanIdentityResolver } from "../../composition/slack-infrastructure.ts";
import type { HumanPrincipal, IdentityService } from "./identity-service";
import { IdentityError } from "./identity-service";

export class ExternalIdentityService implements IdentityService {
    readonly #authentication: AuthenticationConfiguration;
    readonly #clerk: ClerkGateway;
    readonly #humanIdentity: HumanIdentityResolver;

    constructor(cx: {
        readonly gateways: {
            readonly clerk: ClerkGateway;
            readonly humanIdentity: HumanIdentityResolver;
        };
        readonly config: {
            readonly authentication: AuthenticationConfiguration;
        };
    }) {
        const { clerk } = cx.gateways;
        this.#authentication = cx.config.authentication;
        this.#clerk = clerk;
        this.#humanIdentity = cx.gateways.humanIdentity;
    }

    readonly authenticateHuman = async (authorization: string | null, signal: AbortSignal): Promise<HumanPrincipal> => {
        const credential = requireBearer(authorization);
        const session = await this.#clerk.verify(credential, this.#authentication, signal);
        if (session === null) {
            throw new IdentityError("AUTHENTICATION_FAILED", "User authentication failed");
        }
        const userId = await this.#humanIdentity.resolve(session.userId, signal);
        return { humanId: userId, kind: "human", tenantId: userId };
    };

    readonly authorizeHumanBot = async (
        tenantId: string,
        humanId: string,
        botId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        if (tenantId.length === 0 || humanId.length === 0 || botId.length === 0) {
            throw new IdentityError("AUTHORIZATION_FAILED", "Human is not allowed to manage this bot");
        }
    };
}

function requireBearer(authorization: string | null): string {
    if (authorization === null || !/^Bearer [^ ]+$/u.test(authorization)) {
        throw new IdentityError("AUTHENTICATION_FAILED", "Bearer credential is required");
    }
    return authorization.slice("Bearer ".length);
}
