import { Hono } from "hono";
import { errorMiddleware, rethrowHttpError } from "../../../middleware/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { ManagementError } from "../entity/management-error.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createBotManagementRoutes } from "./bot-management-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";
import { createPlatformProjectRoutes } from "./platform-project-routes.ts";
import { createRuntimePairingRoutes } from "./runtime-pairing-routes.ts";

export function createManagementApplication() {
    return new Hono<ManagementHttpEnvironment>()
        .basePath("/mobius-cloud/api")
        .onError(rethrowHttpError)
        .use(
            "*",
            errorMiddleware<ManagementHttpEnvironment>((context) => context.env.logger),
        )
        .use("*", requestHeaders)
        .notFound(() => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .route("/", createAuthenticationRoutes())
        .route("/management", createBotManagementRoutes())
        .route("/management", createPlatformProjectRoutes())
        .route("/management", createRuntimePairingRoutes());
}
