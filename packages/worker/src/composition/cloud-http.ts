import { Hono } from "hono";
import * as v from "valibot";
import type { ComputerBackendService } from "../../../relay/src/service/computer-backend-service.ts";
import { createChatApplication } from "../components/chat/http/index.ts";
import { relayIdentifier } from "../components/management/entity/computer-management.ts";
import { ManagementError } from "../components/management/entity/management-error.ts";
import { anonymousUserRoutes } from "../components/management/http/anonymous-user-routes.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { AccountProvisioner } from "../components/management/service/account-provisioning-service.ts";
import { forwardComputerObject } from "../gateway/computer-object-routing.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { cloudComputerContext, cloudComputerId } from "../middleware/computer-context.ts";
import { accountProvisioner } from "./account-provisioning.ts";
import type { ApplicationContext } from "./application-context.ts";

type CloudHttpEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly dependencies: ApplicationContext };
};

const managementApplication = createManagementApplication();
const computerManagementApplication = createManagementApplication("/morty/api/computers/:computerId");
const chatApplication = createChatApplication();

export function createCloudRoutes(computer: ComputerBackendService) {
    return new Hono<CloudHttpEnvironment>()
        .use("*", cloudComputerContext(computer))
        .all("/computers/:computerId/*", (context) =>
            computerManagementApplication.fetch(context.req.raw, context.var.dependencies),
        )
        .all("/chat", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies))
        .route(
            "/chat",
            new Hono<CloudHttpEnvironment>().all("/*", (context) =>
                chatApplication.fetch(context.req.raw, context.var.dependencies),
            ),
        )
        .all("*", (context) => managementApplication.fetch(context.req.raw, context.var.dependencies));
}

const unauthenticated = () => {
    throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
};

/** Worker-level requests are routed before any computer-scoped services are constructed. */
export const cloudRoutes = new Hono<{
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly provisionAccount: AccountProvisioner };
}>()
    .use("/identity/anonymous-users", async (context, next) => {
        context.set("provisionAccount", accountProvisioner(context.env));
        await next();
    })
    .route("/", anonymousUserRoutes)
    .all("/computers/:computerId/*", async (context) => {
        const id = v.parse(relayIdentifier, context.req.param("computerId"));
        return await forwardComputerObject(context.req.raw, context.env, id);
    })
    .all("/chat/computers/:computerId/*", async (context) => {
        const id = v.parse(relayIdentifier, context.req.param("computerId"));
        return await forwardComputerObject(context.req.raw, context.env, id);
    })
    .post("/identity/transfers/redeem", async (context) => {
        const id = await cloudComputerId(context.req.raw);
        if (id === null) {
            throw new ManagementError("TRANSFER_UNAVAILABLE", "This link is unavailable.", 410);
        }
        return await forwardComputerObject(context.req.raw, context.env, id);
    })
    .all("/session", unauthenticated)
    .all("/chat", unauthenticated);
