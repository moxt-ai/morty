import type { Env, MiddlewareHandler } from "hono";
import { RequestDeadline } from "../http/request-deadline.ts";

interface RequestSignalEnvironment extends Env {
    readonly Variables: { readonly signal: AbortSignal };
}

export function requestTimeoutMiddleware<TEnvironment extends RequestSignalEnvironment>(
    timeoutMilliseconds: number,
    timeoutError?: (cause: unknown) => Error,
): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        const requestSignal = context.req.raw.signal;
        using deadline = new RequestDeadline(requestSignal, timeoutMilliseconds);
        const signal = deadline.signal;
        context.set("signal", signal);
        try {
            await next();
        } catch (error) {
            if (requestSignal.aborted || !signal.aborted || timeoutError === undefined) {
                throw error;
            }
            throw timeoutError(error);
        }
    };
}
