import { Hono } from "hono";
import * as v from "valibot";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { RequestError } from "../infra/request-error.ts";

const assetBindingSchema = v.custom<Fetcher>(
    (value) => typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function",
);

// Keep the document entry points aligned with the application's three routers.
// Unmatched paths must reach the public application's HTTP 404 handler.
const paths = [
    "/chat",
    "/continue",
    "/continue/preview",
    "/continue/preview/:stateId",
    "/playground",
    "/playground/:entryId",
].flatMap((path) => [path, `${path}/`]);

export const webPages = new Hono<{ readonly Bindings: CloudBindings }>().on("GET", paths, async (context) => {
    const assets = v.safeParse(assetBindingSchema, context.env.ASSETS);
    if (!assets.success) {
        throw new RequestError("WEB_ASSETS_UNAVAILABLE", "The application page is unavailable.", 503);
    }
    const request = context.req.raw;
    const response = await assets.output.fetch(
        new Request(new URL("/", request.url), {
            method: request.method,
            headers: request.headers,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        }),
    );
    const page = new Response(response.body, response);
    page.headers.set("X-Robots-Tag", "noindex");
    return page;
});
