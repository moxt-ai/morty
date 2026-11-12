import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { computerFromPath } from "../../../../http/computer-target.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestTimeoutMiddleware } from "../../../../middleware/request-timeout-middleware.ts";
import { logger } from "../../../composition/application-context.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createComputerManagementRoutes } from "./computer-management-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createManagementApplication(initialize: MiddlewareHandler<ManagementHttpEnvironment>) {
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler<ManagementHttpEnvironment>((context) => context.var.application?.logger ?? logger))
        .use(
            "*",
            requestTimeoutMiddleware<ManagementHttpEnvironment>(30_000),
            computerFromPath,
            bodyLimit({ maxSize: 3 * 1_024 * 1_024 }),
            initialize,
            requestHeaders,
        )
        .notFound(() => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .route("/", createAuthenticationRoutes())
        .route("/management", createComputerManagementRoutes());
}
