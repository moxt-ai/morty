import { createMiddleware } from "hono/factory";

export type RequestHeaders = {
    readonly bearerToken: string | undefined;
};

export const requestHeaders = createMiddleware<{ Variables: RequestHeaders }>(async (context, next) => {
    context.set("bearerToken", context.req.header("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1]);
    await next();
});
