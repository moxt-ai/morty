import type { Context, Next } from "hono";

export type RequestHeaders = {
    readonly bearerToken: string | undefined;
};

export async function requestHeaders<E extends { readonly Variables: RequestHeaders }>(
    context: Context<E>,
    next: Next,
) {
    context.set("bearerToken", context.req.header("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1]);
    await next();
}
