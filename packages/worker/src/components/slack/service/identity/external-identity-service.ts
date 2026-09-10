import * as v from "valibot";
import type { HumanIdentity } from "../../gateway/human-identity";
import type { IdentityGateway } from "../../gateway/identity-gateway";
import type { BotPrincipal, HumanPrincipal, IdentityService } from "./identity-service";
import { IdentityError } from "./identity-service";

const credentialPrincipalSchema = v.pipe(
    v.object({
        agentId: v.pipe(v.string(), v.minLength(1)),
        kind: v.literal("agent"),
        tenantId: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const authorizationResponseSchema = v.pipe(
    v.object({ allowed: v.boolean() }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export class ExternalIdentityService implements IdentityService {
    readonly #humanIdentity: HumanIdentity;
    readonly #mobiusBaseUrl: string;
    readonly #gateway: IdentityGateway;

    constructor(cx: {
        readonly gateways: { readonly humanIdentity: HumanIdentity; readonly identityGateway: IdentityGateway };
        readonly config: { readonly mobiusBaseUrl: string };
    }) {
        const { humanIdentity, identityGateway: gateway } = cx.gateways;
        const { mobiusBaseUrl } = cx.config;
        this.#humanIdentity = humanIdentity;
        this.#gateway = gateway;
        this.#mobiusBaseUrl = normalizeBaseUrl(mobiusBaseUrl);
    }

    readonly authenticateHuman = async (authorization: string | null, signal: AbortSignal): Promise<HumanPrincipal> => {
        return await this.#humanIdentity.authenticateHuman(authorization, signal);
    };

    readonly authenticateBot = async (authorization: string | null, signal: AbortSignal): Promise<BotPrincipal> => {
        const credential = requireBearer(authorization);
        const value = await this.#gateway.request(
            `${this.#mobiusBaseUrl}/internal/v1/credentials/verify`,
            { authorization: credential, audience: "app-slack" },
            signal,
        );
        const parsed = v.safeParse(credentialPrincipalSchema, value);
        if (!parsed.success) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Bot credential could not be verified");
        }
        return { kind: "bot", botId: parsed.output.agentId, tenantId: parsed.output.tenantId };
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

    readonly authorizeBot = async (tenantId: string, botId: string, signal: AbortSignal): Promise<void> => {
        const result = v.parse(
            authorizationResponseSchema,
            await this.#gateway.request(
                `${this.#mobiusBaseUrl}/internal/v1/authorization/agent`,
                { agentId: botId, tenantId },
                signal,
            ),
        );
        if (!result.allowed) {
            throw new IdentityError("AUTHORIZATION_FAILED", "Bot is not active in this tenant");
        }
    };
}

function requireBearer(authorization: string | null): string {
    if (authorization === null || !/^Bearer [^ ]+$/u.test(authorization)) {
        throw new IdentityError("AUTHENTICATION_FAILED", "Bearer credential is required");
    }
    return authorization.slice("Bearer ".length);
}

function normalizeBaseUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error("Identity service URLs must use HTTPS");
    }
    return url.toString().replace(/\/$/u, "");
}
