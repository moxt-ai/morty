import { Hono } from "hono";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { RequestError } from "../../../infra/request-error.ts";
import {
    type InstructionDocument,
    instructionOrigin,
    renderInstructionDocument,
} from "../service/instruction-document-service.ts";

function response(document: InstructionDocument, requestUrl: string, configuredOrigin: unknown): Response {
    const origin = instructionOrigin(configuredOrigin === undefined ? new URL(requestUrl).origin : configuredOrigin);
    if (origin === null) {
        throw new RequestError("INVALID_INSTRUCTION_ORIGIN", "The instruction origin is invalid.", 500);
    }
    return new Response(renderInstructionDocument(document, origin), {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=0, s-maxage=300",
        },
    });
}

export const instructionDocumentRoutes = new Hono<{ readonly Bindings: CloudBindings }>()
    .get("/setup.md", (context) => response("setup", context.req.url, context.env.APP_ORIGIN))
    .get("/pair.md", (context) => response("pair", context.req.url, context.env.APP_ORIGIN))
    .get("/setup-help/windows.md", (context) => response("windows", context.req.url, context.env.APP_ORIGIN))
    .get("/setup-help/posix.md", (context) => response("posix", context.req.url, context.env.APP_ORIGIN));
