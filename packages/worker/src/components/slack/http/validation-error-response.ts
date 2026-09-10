import type { ErrorToResponse } from "../infra/error-to-response";

export class ValidationErrorResponse implements ErrorToResponse {
    readonly toResponse = (): Response =>
        Response.json(
            {
                error: {
                    code: "INVALID_REQUEST",
                    message: "Request validation failed",
                },
            },
            { status: 400 },
        );
}
