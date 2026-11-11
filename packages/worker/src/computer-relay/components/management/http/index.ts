import { Hono } from "hono";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { errorHandler } from "../../../../http/error-middleware.ts";
import { requestHeaders } from "../../../middleware/request-headers.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import { createBotManagementRoutes } from "./bot-management-routes.ts";
import { createComputerManagementRoutes } from "./computer-management-routes.ts";
import { createComputerPairingRoutes } from "./computer-pairing-routes.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createManagementApplication() {
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler<ManagementHttpEnvironment>((context) => context.var.application.logger))
        .use("*", requestHeaders)
        .notFound(() => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .route("/", createAuthenticationRoutes())
        .route("/management", createBotManagementRoutes())
        .route("/management", createComputerManagementRoutes())
        .route("/management", createComputerPairingRoutes());
}
