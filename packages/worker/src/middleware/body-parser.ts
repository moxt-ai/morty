import type { Env, MiddlewareHandler } from "hono";
import { assertRequiredKeys, parseJsonBody } from "../infra/relay-http.ts";

export type ParsedBodyInput = {
    readonly in: { readonly json: unknown };
    readonly out: { readonly json: Readonly<Record<string, unknown>> };
};

export function bodyParser<TEnvironment extends Env, TPath extends string = string>(
    requiredFields?: readonly string[],
): MiddlewareHandler<TEnvironment, TPath, ParsedBodyInput> {
    return async (context, next) => {
        const body = await parseJsonBody(context.req.raw);
        if (requiredFields !== undefined) {
            assertRequiredKeys(body, requiredFields);
        }
        context.req.addValidatedData("json", body);
        await next();
    };
}
