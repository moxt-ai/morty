import type { HttpError } from "../../../../infra/http-error.ts";

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
    readonly authenticateBot: (bearerToken: string, signal: AbortSignal) => Promise<BotPrincipal>;
    readonly authenticateHuman: (bearerToken: string, signal: AbortSignal) => Promise<HumanPrincipal>;
}

export class IdentityError extends Error implements HttpError {
    readonly code: "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED";
    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.code === "AUTHENTICATION_FAILED" ? 401 : 403,
    });

    constructor(code: "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED", message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "IdentityError";
        this.code = code;
    }
}
