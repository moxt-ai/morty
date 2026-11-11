import { MORTY_API_PREFIX, parseMortyApiPrefix } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { createChannelRoutes } from "./channel/channel-routes.ts";
import { rethrowHonoError } from "./middleware/error-middleware.ts";
import { createProjectRuntimePairingRoutes } from "./pairing/project-runtime-pairing-routes.ts";
import type { RelayHttpEnvironment } from "./relay-http-environment.ts";

export function createRelayProtocolRoutes(apiPrefix: string = MORTY_API_PREFIX) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(parseMortyApiPrefix(apiPrefix))
        .onError(rethrowHonoError)
        .route("/v1", createProjectRuntimePairingRoutes())
        .route("/channels", createChannelRoutes());
}
