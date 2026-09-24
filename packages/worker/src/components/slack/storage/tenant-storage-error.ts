import type { HttpError } from "../../../infra/http-error.ts";

export class TenantStorageError extends Error implements HttpError {
    readonly code = "SLACK_STORAGE_UNAVAILABLE";
    constructor(options?: ErrorOptions) {
        super("Slack storage is temporarily unavailable.", options);
        this.name = "TenantStorageError";
    }
    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: 503,
    });
}
