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
