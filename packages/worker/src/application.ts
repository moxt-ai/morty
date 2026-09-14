import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createChatApplication } from "./components/chat/chat-routes.ts";
import { createManagementApplication } from "./components/management/http/create-application.ts";
import { slackApplication } from "./components/slack/slack-application.ts";
import { type ApplicationContext, createApplicationDependencies } from "./composition/application-context.ts";
import { chatRequestBindings, projectBindings } from "./composition/chat-shards.ts";
import { applicationErrorResponse } from "./infra/application-error.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { json } from "./infra/http.ts";

const managementApplication = createManagementApplication();
const chatApplication = createChatApplication().onError((error, context) =>
    applicationErrorResponse(error, context.env.logger),
);

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const cloudRoutes = new Hono<CloudHttpEnvironment>()
    .use("*", async (context, next) => {
        context.set(
            "dependencies",
            createApplicationDependencies(await chatRequestBindings(context.req.raw, context.env)),
        );
        await next();
    })
    .all("/chat", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies))
    .route(
        "/chat",
        new Hono<CloudHttpEnvironment>().all("/*", (context) =>
            chatApplication.fetch(context.req.raw, context.var.dependencies),
        ),
    )
    .all("*", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies));

const slackRoutes = new Hono<{ readonly Bindings: CloudBindings }>().all("*", async (context) => {
    const request = context.req.raw;
    const projectId = request.headers.get("X-Mobius-Project-Id") ?? context.req.query("projectId");
    if (projectId === undefined) {
        return json({ error: { code: "PROJECT_REQUIRED", message: "Project context is required." } }, 400);
    }
    return await slackApplication.fetch(
        request,
        await projectBindings(context.env, projectId, AbortSignal.any([request.signal, AbortSignal.timeout(20000)])),
    );
});

const notFound = () => json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);

const application = new Hono<{ readonly Bindings: CloudBindings }>()
    .use("/mobius-cloud/api/*", bodyLimit({ maxSize: 110000 }))
    .onError((error, context) => applicationErrorResponse(error, createApplicationDependencies(context.env).logger))
    .all("/mobius-cloud/api", notFound)
    .all("/mobius-slack/api", notFound)
    .route("/mobius-cloud/api", cloudRoutes)
    .route("/mobius-slack/api", slackRoutes)
    .notFound(notFound);

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        return await application.fetch(request, bindings, context);
    },
    async queue(batch, bindings): Promise<void> {
        await slackApplication.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, unknown>;
