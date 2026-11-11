import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { validateAgents, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { bearerToken } from "../../../../infra/relay-http.ts";
import { bodyParser } from "../../../../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../middleware/error-middleware.ts";
import type { RelayProtocolEnvironment as RelayHttpEnvironment } from "../../../http/environment.ts";

export function createComputerRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .put("/:computerId/catalog", bodyParser<RelayHttpEnvironment>(["agents"]), async (context) => {
            const useCases = context.var.relay.services.computerConnections;
            const body = context.req.valid("json");
            const agents = validateAgents(body["agents"]);
            await useCases.updateAgentCatalog(
                validateIdentifier(context.req.param("computerId"), "computer_id"),
                bearerToken(context.req.raw),
                context.req.header(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? null,
                agents,
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        });
}
