import type { Context, Env, MiddlewareHandler } from "hono";
import { ValiError } from "valibot";
import { json } from "../infra/http.ts";
import { isHttpError } from "../infra/http-error.ts";

interface ErrorLogger {
    readonly error: (value: unknown, message: string) => void;
}

export function rethrowHttpError(error: Error): never {
    throw error;
}

export function errorMiddleware<TEnvironment extends Env>(
    getLogger: (context: Context<TEnvironment>) => ErrorLogger,
): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        try {
            return await next();
        } catch (error) {
            getLogger(context).error({ err: error }, "Application request failed");
            if (error instanceof ValiError) {
                return json({ error: { code: "INVALID_REQUEST", message: "The request is invalid." } }, 400);
            }
            if (isHttpError(error)) {
                const response = error.toHttpJson();
                return json(response.body, response.status, response.headers);
            }
            return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, 500);
        }
    };
}
