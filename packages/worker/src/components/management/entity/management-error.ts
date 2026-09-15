import type { HttpError } from "../../../infra/http-error.ts";

export class ManagementError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    constructor(
        code: string,
        message: string,
        status: number,
        headers: Readonly<Record<string, string>> = {},
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.headers = headers;
        this.name = "ManagementError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.status,
        headers: this.headers,
    });
}
