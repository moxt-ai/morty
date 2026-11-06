import { DurableObject } from "cloudflare:workers";
import platform from "../third-party/platform/packages/relay-cloudflare-platform/src/worker.ts";

export * from "../third-party/platform/packages/relay-cloudflare-platform/src/worker.ts";

// Keep the migration namespace and its receipts across ordinary releases and
// rollback. Normal business requests never invoke this retained class.
export class MigrationControl extends DurableObject {}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url),
            prefix = "/__clerk";
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
            return platform.fetch(request, env, ctx);
        }
        if (!env.CLERK_PROXY_URL) {
            return new Response(null, { status: 404 });
        }
        const proxy = new URL(env.CLERK_PROXY_URL);
        if (url.origin !== proxy.origin || !env.CLERK_SECRET_KEY) {
            return Response.json({ error: { code: "clerk_proxy_unavailable" } }, { status: 503 });
        }
        const upstream = new URL("https://frontend-api.clerk.dev");
        upstream.pathname = url.pathname.slice(prefix.length) || "/";
        upstream.search = url.search;
        const headers = new Headers(request.headers);
        headers.set("Clerk-Proxy-Url", env.CLERK_PROXY_URL);
        headers.set("Clerk-Secret-Key", env.CLERK_SECRET_KEY);
        headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") || "");
        headers.delete("host");
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
        const forwarded = new Request(upstream, new Request(request, { headers, redirect: "manual", signal }));
        const response = await fetch(forwarded);
        const result = new Response(response.body, response);
        result.headers.delete("Clerk-Secret-Key");
        result.headers.set("Cache-Control", "private, no-store");
        return result;
    },
};
