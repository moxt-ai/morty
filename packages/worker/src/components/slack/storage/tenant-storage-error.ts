import type { ErrorToResponse } from "../infra/util/error-to-response";

export class TenantStorageError extends Error implements ErrorToResponse {
    readonly code = "SLACK_STORAGE_UNAVAILABLE";
    constructor(options?: ErrorOptions) {
        super("Slack storage is temporarily unavailable.", options);
        this.name = "TenantStorageError";
    }
    readonly toResponse = (): Response =>
        Response.json({ error: { code: this.code, message: this.message } }, { status: 503 });
}
