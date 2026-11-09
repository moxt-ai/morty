import { Hono } from "hono";
import { createChatApplication } from "../components/chat/http/index.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { cloudAccountContext } from "../middleware/account-context.ts";
import type { ApplicationContext } from "./application-context.ts";

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const managementApplication = createManagementApplication();
const projectManagementApplication = createManagementApplication("/morty/api/accounts/:accountId");
const chatApplication = createChatApplication();

export const cloudRoutes = new Hono<CloudHttpEnvironment>()
    .use("*", cloudAccountContext)
    .all("/accounts/:accountId/*", (context) =>
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
    .get("/accounts/:accountId/session", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/accounts/:accountId/management/bot", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/accounts/:accountId/management/bots/:botId/runtime-binding", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .get("/accounts/:accountId/management/account", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/accounts/:accountId/management/account/replacement", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/accounts/:accountId/management/runtime-pairings", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .get("/accounts/:accountId/management/runtime-pairings/:pairingId", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/accounts/:accountId/identity/transfers", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .get("/accounts/:accountId/identity/devices", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/accounts/:accountId/identity/revoke-all-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/accounts/:accountId/identity/recovery-token", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .delete("/accounts/:accountId/identity/v1/browser-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/accounts/:accountId/identity/v1/devices/:deviceId", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/accounts/:accountId/identity/v1/other-browser-access", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/accounts/:accountId/identity/v1/recovery-credential", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .delete("/accounts/:accountId/identity/v1/local-credential", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/accounts/:accountId/bots/:botId/setup", (context) => cloudRoutes.fetch(context.req.raw, context.env))
    .post("/chat/accounts/:accountId/bots/:botId/setup/runtimes", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/accounts/:accountId/bots/:botId/workspace", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    )
    .post("/chat/accounts/:accountId/bots/:botId/agent-settings", (context) =>
        cloudRoutes.fetch(context.req.raw, context.env),
    );
