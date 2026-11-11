import { MORTY_API_PREFIX, parseMortyApiPrefix } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { createChannelRoutes } from "./http/channel/channel-routes.ts";
import { rethrowHonoError } from "./http/middleware/error-middleware.ts";
import { createProjectComputerPairingRoutes } from "./http/pairing/project-computer-pairing-routes.ts";
import type { RelayHttpEnvironment } from "./http/relay-http-environment.ts";

export function createMortyApplication(apiPrefix: string = MORTY_API_PREFIX) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(parseMortyApiPrefix(apiPrefix))
        .onError(rethrowHonoError)
        .notFound(notFoundResponse)
        .route("/v1", createProjectComputerPairingRoutes())
        .route("/channels", createChannelRoutes());
}

/** Unmatched routes must carry a stable machine-readable code so SDK callers can branch on it. */
function notFoundResponse(): Response {
    return Response.json(
        { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
        { status: 404 },
    );
}
