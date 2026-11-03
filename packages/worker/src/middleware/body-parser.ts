import type { Env } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { RequestError } from "../infra/request-error.ts";

export function bodyParser<TEnvironment extends Env, TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
) {
    return createMiddleware<
        TEnvironment,
        string,
        { in: { json: v.InferInput<TSchema> }; out: { json: v.InferOutput<TSchema> } }
    >(async (context, next) => {
        context.req.addValidatedData("json", v.parse(schema, await readJsonBody(context.req.raw)));
        await next();
    });
}

/**
 * Like `bodyParser`, for a request whose body is optional: an empty request without a content type reads as an empty
 * object, and anything else must be valid JSON. Forwarding may turn a missing body into an empty one.
 */
export function optionalBodyParser<TEnvironment extends Env, TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
) {
    return createMiddleware<
        TEnvironment,
        string,
        { in: { json: v.InferInput<TSchema> }; out: { json: v.InferOutput<TSchema> } }
    >(async (context, next) => {
        const request = context.req.raw;
        const empty = !request.headers.has("content-type") && (await request.clone().text()) === "";
        context.req.addValidatedData("json", v.parse(schema, empty ? {} : await readJsonBody(request)));
        await next();
    });
}

type JsonRequest = Pick<Request, "headers" | "json" | "signal">;

export async function readJsonBody(request: JsonRequest): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new RequestError("INVALID_REQUEST", "A JSON request is required.", 400);
    }
    try {
        const body: unknown = await request.json();
        request.signal.throwIfAborted();
        return body;
    } catch (cause) {
        request.signal.throwIfAborted();
        if (cause instanceof SyntaxError) {
            throw new RequestError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
        }
        throw cause;
    }
}
