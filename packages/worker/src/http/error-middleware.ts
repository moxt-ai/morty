import type { Context, Env, ErrorHandler } from "hono";
import { ValiError } from "valibot";
import { isHttpError } from "../contracts/http-error.ts";
import { json } from "./json.ts";

interface ErrorLogger {
    readonly error: (value: Readonly<Record<string, unknown>>, message: string) => void;
}

/** Hono's error boundary replaces even a response prepared before a final authorization check failed. */
export function errorHandler<TEnvironment extends Env>(
    getLogger: (context: Context<TEnvironment>) => ErrorLogger,
): ErrorHandler<TEnvironment> {
    return (error, context) => {
        if (context.req.raw.signal.aborted) {
            throw error;
        }
        getLogger(context).error({ err: error }, "Application request failed");
        if (error instanceof ValiError) {
            return json({ error: { code: "INVALID_REQUEST", message: "The request is invalid." } }, 400);
        }
        if (isHttpError(error)) {
            const response = error.toHttpJson();
            return json(response.body, response.status, response.headers);
        }
        return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, 500);
    };
}
