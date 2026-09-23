import { Hono } from "hono";
import { createChatApplication } from "../components/chat/http/index.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { cloudProjectContext } from "../middleware/project-context.ts";
import type { ApplicationContext } from "./application-context.ts";

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const managementApplication = createManagementApplication();
const projectManagementApplication = createManagementApplication("/morty/api/projects/:projectId");
const chatApplication = createChatApplication();

export const cloudRoutes = new Hono<CloudHttpEnvironment>()
    .use("*", cloudProjectContext)
    .all("/projects/:projectId/*", (context) =>
        projectManagementApplication.fetch(context.req.raw, context.var.dependencies),
    )
    .all("/chat", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies))
    .route(
        "/chat",
        new Hono<CloudHttpEnvironment>().all("/*", (context) =>
            chatApplication.fetch(context.req.raw, context.var.dependencies),
        ),
    )
    .all("*", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies));

export const publicCloudRoutes = new Hono<{ readonly Bindings: CloudBindings }>()
    .post("/identity/anonymous-users", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/identity/pairings/redeem", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/projects/:projectId/session", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/projects/:projectId/management/bots", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/projects/:projectId/management/project", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/projects/:projectId/management/runtime-pairings", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .get("/projects/:projectId/management/runtime-pairings/:pairingId", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/projects/:projectId/identity/pairings", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/projects/:projectId/identity/transfers", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/chat/projects/:projectId/bots/:botId/setup", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/chat/projects/:projectId/bots/:botId/workspace", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    );
