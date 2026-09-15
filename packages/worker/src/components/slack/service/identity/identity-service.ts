export interface HumanPrincipal {
    readonly humanId: string;
    readonly kind: "human";
    readonly tenantId: string;
}

export interface BotPrincipal {
    readonly botId: string;
    readonly kind: "bot";
    readonly tenantId: string;
}

export interface IdentityService {
    readonly authenticateBot: (authorization: string | null, signal: AbortSignal) => Promise<BotPrincipal>;
    readonly authenticateHuman: (authorization: string | null, signal: AbortSignal) => Promise<HumanPrincipal>;
}

import type { ErrorToResponse } from "../../infra/util/error-to-response";

export class IdentityError extends Error implements ErrorToResponse {
    readonly code: "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED";
    readonly toResponse = (): Response =>
        Response.json(
            { error: { code: this.code, message: this.message } },
            { status: this.code === "AUTHENTICATION_FAILED" ? 401 : 403 },
        );

    constructor(code: "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED", message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "IdentityError";
        this.code = code;
    }
}
