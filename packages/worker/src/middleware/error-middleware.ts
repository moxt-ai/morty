import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { toHttpError } from "../contracts/http-error.ts";
import { requestLogContext } from "../infra/log-diagnostics.ts";
import { logger } from "../infra/logger.ts";

export function rethrowHonoError(error: Error): never {
    throw error;
}

/** Mounted routes need an error handler: the host can consume exceptions before upstream middleware sees them. */
export function relayErrorHandler(error: unknown, context: Context): Response {
    logger.error(
        { ...requestLogContext(context.req.raw), err: error, event: "request_failed" },
        "Morty request failed",
    );
    if (context.req.raw.signal.aborted) {
        throw error;
    }
    const response = toHttpError(error);
    const result = Response.json(response.body, {
        status: response.status,
        headers: response.headers ?? {},
    });
    return context.newResponse(result.body, result);
}

export const errorMiddleware = createMiddleware(async (context, next) => {
    try {
        return await next();
    } catch (error) {
        return relayErrorHandler(error, context);
    }
});
