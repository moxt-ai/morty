import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { createComputerRoutes } from "./computer/computer-routes.ts";
import { rethrowHonoError } from "./middleware/error-middleware.ts";
import { createProjectRuntimePairingRoutes } from "./pairing/project-computer-pairing-routes.ts";
import type { RelayHttpEnvironment } from "./relay-http-environment.ts";

export function createRelayProtocolRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .basePath(MORTY_API_PREFIX)
        .onError(rethrowHonoError)
        .route("/v1", createProjectRuntimePairingRoutes())
        .route("/channels", createComputerRoutes());
}
