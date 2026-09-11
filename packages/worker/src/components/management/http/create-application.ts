import { Hono } from "hono";
import { applicationErrorResponse } from "../../../infra/application-error.ts";
import { json } from "../../../infra/http.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createBotManagementRoutes } from "./bot-management-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { createPlatformProjectRoutes } from "./platform-project-routes.ts";

export function createManagementApplication() {
    return new Hono<ManagementHttpEnvironment>()
        .basePath("/mobius-cloud/api")
        .onError((error, context) => applicationErrorResponse(error, context.env.logger))
        .notFound(() => json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404))
        .route("/", createAuthenticationRoutes())
        .route("/management", createBotManagementRoutes())
        .route("/management", createPlatformProjectRoutes());
}
