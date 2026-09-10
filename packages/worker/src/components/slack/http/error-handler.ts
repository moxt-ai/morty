import { ValiError } from "valibot";
import { hasErrorResponse } from "../infra/util/error-to-response";
import { ValidationErrorResponse } from "./validation-error-response";

export function handleError(error: Error): Response {
    const response = error instanceof ValiError ? new ValidationErrorResponse() : error;
    if (hasErrorResponse(response)) {
        return response.toResponse();
    }
    console.error("Unhandled Slack application error", error);
    return Response.json(
        {
            error: {
                code: "INTERNAL_ERROR",
                message: "The request could not be completed",
            },
        },
        { status: 500 },
    );
}
