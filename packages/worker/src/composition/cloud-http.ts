import { Hono } from "hono";
import { createChatApplication } from "../components/chat/http/index.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { cloudComputerContext } from "../middleware/computer-context.ts";
import type { ApplicationContext } from "./application-context.ts";

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const managementApplication = createManagementApplication();
const projectManagementApplication = createManagementApplication("/morty/api/computers/:computerId");
const chatApplication = createChatApplication();

export const cloudRoutes = new Hono<CloudHttpEnvironment>()
    .use("*", cloudComputerContext)
    .all("/computers/:computerId/*", (context) =>
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
    .get("/computers/:computerId/session", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/computers/:computerId/management/bot", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/computers/:computerId/management/bots/:botId/runtime-binding", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .get("/computers/:computerId/management/computer", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/computers/:computerId/management/computer/replacement", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/computers/:computerId/management/pairings", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/computers/:computerId/management/pairings/:pairingId", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/computers/:computerId/identity/transfers", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/computers/:computerId/identity/devices", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/computers/:computerId/identity/revoke-all-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/computers/:computerId/identity/recovery-token", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/computers/:computerId/identity/v1/browser-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/computers/:computerId/identity/v1/devices/:deviceId", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/computers/:computerId/identity/v1/other-browser-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/computers/:computerId/identity/v1/recovery-credential", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/computers/:computerId/identity/v1/local-credential", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/computers/:computerId/bots/:botId/setup", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/chat/computers/:computerId/bots/:botId/setup/runtimes", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/computers/:computerId/bots/:botId/workspace", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/computers/:computerId/bots/:botId/agent-settings", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    );
