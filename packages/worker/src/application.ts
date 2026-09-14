import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createChatApplication } from "./components/chat/chat-routes.ts";
import { createManagementApplication } from "./components/management/http/create-application.ts";
import { slackApplication } from "./components/slack/slack-application.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { chatRequestBindings, projectBindings } from "./composition/chat-shards.ts";
import { applicationErrorResponse } from "./infra/application-error.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { json } from "./infra/http.ts";

const managementApplication = createManagementApplication();
const chatApplication = createChatApplication().onError((error, context) =>
    applicationErrorResponse(error, context.env.logger),
);

const application = new Hono<{ Bindings: CloudBindings }>()
    .use("/mobius-cloud/api/*", bodyLimit({ maxSize: 110000 }))
    .onError((error, context) => applicationErrorResponse(error, createApplicationDependencies(context.env).logger))
    .all("*", async (context) => {
        const request = context.req.raw;
        const bindings = context.env;
        const path = new URL(request.url).pathname;
        const dependencies = createApplicationDependencies(
            path.startsWith("/mobius-cloud/api/") ? await chatRequestBindings(request, bindings) : bindings,
        );
        if (path.startsWith("/mobius-cloud/api/chat/")) {
            return await chatApplication.fetch(request, dependencies);
        }
        if (path.startsWith("/mobius-cloud/api/")) {
            return await managementApplication.fetch(request, dependencies);
        }
        if (path.startsWith("/mobius-slack/api/")) {
            const projectId =
                request.headers.get("X-Mobius-Project-Id") ?? new URL(request.url).searchParams.get("projectId");
            if (projectId === null) {
                return json({ error: { code: "PROJECT_REQUIRED", message: "Project context is required." } }, 400);
            }
            return await slackApplication.fetch(
                request,
                await projectBindings(
                    bindings,
                    projectId,
                    AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
                ),
            );
        }
        return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    });

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        return await application.fetch(request, bindings, context);
    },
    async queue(batch, bindings): Promise<void> {
        await slackApplication.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, unknown>;
