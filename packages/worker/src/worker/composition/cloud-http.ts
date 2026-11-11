import { Hono } from "hono";
import type { AccountProvisioner } from "../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { anonymousUserRoutes } from "../components/management/http/anonymous-user-routes.ts";
import { accountProvisioner } from "./account-provisioning.ts";

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
    .all("/session", unauthenticated);
