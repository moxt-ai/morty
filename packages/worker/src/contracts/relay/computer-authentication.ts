import type { HttpError } from "../http-error.ts";
export interface ComputerAccess {
    readonly computerId: string;
}

export class ComputerAuthenticationError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ComputerAuthenticationError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: computerAuthenticationErrorStatus(this.code),
    });
}

function computerAuthenticationErrorStatus(code: string): number {
    switch (code) {
        case "credential_expired":
        case "credential_revoked":
        case "credential_invalid":
            return 401;
        case "computer_access_denied":
        case "session_permission_denied":
            return 403;
        default:
            return 503;
    }
}
