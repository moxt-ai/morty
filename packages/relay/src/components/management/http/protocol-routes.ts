import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono } from "hono";
import type { RelayHttpEnvironment } from "../../../composition/relay-protocol-environment.ts";
import { rethrowHonoError } from "../../../middleware/error-middleware.ts";
import { createChannelRoutes } from "./channel-routes.ts";
import { createProjectRuntimePairingRoutes } from "./project-runtime-pairing-routes.ts";

export function createRelayProtocolRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .basePath(MORTY_API_PREFIX)
        .onError(rethrowHonoError)
        .route("/v1", createProjectRuntimePairingRoutes())
        .route("/channels", createChannelRoutes());
}
