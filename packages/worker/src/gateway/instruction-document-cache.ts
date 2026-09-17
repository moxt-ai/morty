import { instructionOrigin } from "../components/instruction-documents/service/instruction-document-service.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

type WorkerFetch = (request: Request, bindings: CloudBindings, context?: ExecutionContext) => Promise<Response>;

export function withInstructionDocumentCache(next: WorkerFetch): WorkerFetch {
    return async (request, bindings, context) => {
        const url = new URL(request.url);
        if (request.method !== "GET" || (url.pathname !== "/setup.md" && url.pathname !== "/pair.md")) {
            return next(request, bindings, context);
        }
        const origin = instructionOrigin(bindings.APP_ORIGIN === undefined ? url.origin : bindings.APP_ORIGIN);
        if (origin === null) {
            return next(request, bindings, context);
        }
        // Tickets never affect the document. Keep them out of the edge cache key.
        url.search = "";
        url.searchParams.set("origin", origin);
        const cacheKey = new Request(url, { method: "GET" });
        const cache = await caches.open("instruction-documents");
        const cached = await cache.match(cacheKey);
        if (cached) {
            const response = new Response(cached.body, cached);
            response.headers.set("X-Instruction-Cache", "HIT");
            return response;
        }
        const response = await next(request, bindings, context);
        if (response.status === 200) {
            await cache.put(cacheKey, response.clone());
            response.headers.set("X-Instruction-Cache", "MISS");
        }
        return response;
    };
}
