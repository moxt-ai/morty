import { ValiError } from "valibot";
import { isHttpError } from "../../../infra/http-error.ts";
import { hasErrorResponse } from "../infra/util/error-to-response";
import { ValidationErrorResponse } from "./validation-error-response";

export function handleError(error: Error): Response {
    if (isHttpError(error)) {
        const response = error.toHttpJson();
        return Response.json(
            response.body,
            response.headers === undefined
                ? { status: response.status }
                : { status: response.status, headers: response.headers },
        );
    }
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
