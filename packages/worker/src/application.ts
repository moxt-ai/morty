import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createChatApplication } from "./components/chat/chat-routes.ts";
import { createManagementApplication } from "./components/management/http/create-application.ts";
import { slackApplication } from "./components/slack/slack-application.ts";
import { type ApplicationContext, createApplicationDependencies } from "./composition/application-context.ts";
import { instructionDocuments } from "./gateway/instruction-documents.ts";
import { applicationErrorResponse } from "./infra/application-error.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { json } from "./infra/http.ts";
import { cloudProjectContext, slackProjectContext } from "./middleware/project-context.ts";

const managementApplication = createManagementApplication();
const chatApplication = createChatApplication().onError((error, context) =>
    applicationErrorResponse(error, context.env.logger),
);

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const cloudRoutes = new Hono<CloudHttpEnvironment>()
    .use("*", cloudProjectContext)
    .all("/chat", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies))
    .route(
        "/chat",
        new Hono<CloudHttpEnvironment>().all("/*", (context) =>
            chatApplication.fetch(context.req.raw, context.var.dependencies),
        ),
    )
    .all("*", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies));

const slackRoutes = new Hono<{ readonly Bindings: CloudBindings }>()
    .use("*", slackProjectContext)
    .all("*", (context) => slackApplication.fetch(context.req.raw, context.var.projectBindings));

const notFound = () => json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);

const application = new Hono<{ readonly Bindings: CloudBindings }>()
    .use("/mobius-cloud/api/*", bodyLimit({ maxSize: 110000 }))
    .onError((error, context) => applicationErrorResponse(error, createApplicationDependencies(context.env).logger))
    .all("/mobius-cloud/api", notFound)
    .all("/mobius-slack/api", notFound)
    .route("/", instructionDocuments)
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
