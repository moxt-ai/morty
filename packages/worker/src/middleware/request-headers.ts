import { createMiddleware } from "hono/factory";

export type RequestHeaders = {
    readonly bearerToken: string | undefined;
    readonly mediaType: string | undefined;
};

export const requestHeaders = createMiddleware<{ Variables: RequestHeaders }>(async (context, next) => {
    context.set("bearerToken", context.req.header("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1]);
    context.set("mediaType", context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase());
    await next();
});
