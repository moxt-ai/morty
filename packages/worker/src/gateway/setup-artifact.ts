import { Hono } from "hono";
import * as v from "valibot";
import { type CloudBindings, readableR2BucketBindingSchema } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";

export const setupArtifact = new Hono<{ readonly Bindings: CloudBindings }>().get("/setup.mjs", async (context) => {
    const unavailable = () =>
        json(
            {
                error: {
                    code: "SETUP_ARTIFACT_UNAVAILABLE",
                    message: "The setup download is unavailable.",
                },
            },
            503,
        );
    const parsed = v.safeParse(readableR2BucketBindingSchema, context.env.CHAT_ATTACHMENTS_APAC);
    if (!parsed.success) {
        return unavailable();
    }
    const bucket = parsed.output;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15000);
    const signal = AbortSignal.any([context.req.raw.signal, deadline.signal]);
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        // R2 has no cancellation parameter. Consume the small bundle even if the
        // caller leaves, while bounding the HTTP request's wait independently.
        const download = bucket
            .get("artifacts/setup.mjs")
            .then(async (object) => (object === null ? null : await object.arrayBuffer()));
        const body = await Promise.race([download, aborted.promise]);
        return body === null
            ? unavailable()
            : new Response(body, {
                  headers: {
                      "Content-Type": "text/javascript; charset=utf-8",
                      "Cache-Control": "no-cache",
                  },
              });
    } catch {
        context.req.raw.signal.throwIfAborted();
        return unavailable();
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
    }
});
