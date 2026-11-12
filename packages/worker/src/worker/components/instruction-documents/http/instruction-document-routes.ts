import { Hono } from "hono";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { RequestError } from "../../../../http/request-error.ts";
import { instructionOrigin, renderSetupDocument } from "../service/instruction-document-service.ts";

function setupResponse(requestUrl: string, configuredOrigin: unknown): Response {
    const origin = instructionOrigin(configuredOrigin === undefined ? new URL(requestUrl).origin : configuredOrigin);
    if (origin === null) {
        throw new RequestError("INVALID_INSTRUCTION_ORIGIN", "The instruction origin is invalid.", 500);
    }
    return new Response(renderSetupDocument(origin), {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=0, s-maxage=300",
        },
    });
}

export const instructionDocumentRoutes = new Hono<{ readonly Bindings: CloudBindings }>().get("/setup.md", (context) =>
    setupResponse(context.req.url, context.env.APP_ORIGIN),
);
