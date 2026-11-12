import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { rethrowHonoError } from "../../../../middleware/error-middleware.ts";
import type {
    RelayProtocolEnvironment as RelayHttpEnvironment,
    RelayRouteMiddleware,
} from "../../../http/environment.ts";
import { createComputerRoutes } from "./computer-routes.ts";
import { createProjectComputerPairingRoutes } from "./project-computer-pairing-routes.ts";

export function createRelayProtocolRoutes(middleware: RelayRouteMiddleware, runtimeMiddleware: RelayRouteMiddleware) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(MORTY_API_PREFIX)
        .onError(rethrowHonoError)
        .route("/v1", createProjectComputerPairingRoutes(middleware, runtimeMiddleware))
        .route("/channels", createComputerRoutes(...middleware));
}
