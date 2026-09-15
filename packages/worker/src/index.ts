import * as v from "valibot";
import application from "./application.ts";
import { instructionOriginSchema } from "./gateway/instruction-documents.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";

export { BotTriggerRateLimiter } from "./components/slack/do/bot-trigger-rate-limiter.ts";

export default {
    async fetch(request: Request, bindings: CloudBindings, context: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (request.method !== "GET" || (url.pathname !== "/setup.md" && url.pathname !== "/pair.md")) {
            return application.fetch(request, bindings, context);
        }
        const origin = v.safeParse(
            instructionOriginSchema,
            bindings.APP_ORIGIN === undefined ? url.origin : bindings.APP_ORIGIN,
        );
        if (!origin.success) {
            return application.fetch(request, bindings, context);
        }
        // Tickets never affect the document. Keep them out of the edge cache key.
        url.search = "";
        url.searchParams.set("origin", origin.output);
        const cacheKey = new Request(url, { method: "GET" });
        const cache = await caches.open("instruction-documents");
        const cached = await cache.match(cacheKey);
        if (cached) {
            const response = new Response(cached.body, cached);
            response.headers.set("X-Instruction-Cache", "HIT");
            return response;
        }
        const response = await application.fetch(request, bindings, context);
        if (response.status === 200) {
            await cache.put(cacheKey, response.clone());
            response.headers.set("X-Instruction-Cache", "MISS");
        }
        return response;
    },
    queue: application.queue,
} satisfies ExportedHandler<CloudBindings, unknown>;
