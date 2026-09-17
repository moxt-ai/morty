import type { HttpError } from "./http-error.ts";

export class RequestError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.name = "RequestError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
    });
}
