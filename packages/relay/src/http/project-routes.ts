import { createMortyApplication, errorMiddleware, type RelayContext, rethrowHonoError } from "@morty-build/relay-core";
import { Hono } from "hono";

export function createProjectApplication() {
    const projectApplication = createMortyApplication();
    return new Hono<{
        readonly Bindings: { readonly relay: RelayContext; readonly allowedOrigins: ReadonlySet<string> };
    }>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .all("*", async (context) => await projectApplication.fetch(context.req.raw, context.env.relay));
}
