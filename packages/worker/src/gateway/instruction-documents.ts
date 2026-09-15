import { Hono } from "hono";
import * as v from "valibot";
import pairTemplate from "../../../../templates/pair.md?raw";
import setupTemplate from "../../../../templates/setup.md?raw";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { RequestError } from "../infra/request-error.ts";

export const instructionOriginSchema = v.pipe(
    v.string(),
    v.url(),
    v.regex(/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/u),
    v.check((value) => URL.canParse(value) && new URL(value).origin === value),
);

export const instructionDocuments = new Hono<{ readonly Bindings: CloudBindings }>().on(
    "GET",
    ["/setup.md", "/pair.md"],
    (context) => {
        const origin = v.safeParse(
            instructionOriginSchema,
            context.env.APP_ORIGIN === undefined ? new URL(context.req.url).origin : context.env.APP_ORIGIN,
        );
        if (!origin.success) {
            throw new RequestError("INVALID_INSTRUCTION_ORIGIN", "The instruction origin is invalid.", 500);
        }
        const template = context.req.path === "/setup.md" ? setupTemplate : pairTemplate;
        return new Response(template.replaceAll("{{BASE_URL}}", origin.output), {
            headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                "Cache-Control": "public, max-age=0, s-maxage=300",
            },
        });
    },
);
