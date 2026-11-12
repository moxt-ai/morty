import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import { validateAgents, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { bearerToken } from "../../../../http/bearer-token.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../../../../http/error-middleware.ts";
import { protocolBodyLimit } from "../../../../http/protocol-body-limit.ts";
import type {
    RelayProtocolEnvironment as RelayHttpEnvironment,
    RelayRouteMiddleware,
} from "../../../http/environment.ts";

// validateAgents decodes the catalog and reports its own error code.
const catalogRequestSchema = v.object({ agents: v.unknown() });

export function createComputerRoutes(...[timeout, target, initialize]: RelayRouteMiddleware) {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .put(
            "/:computerId/catalog",
            timeout,
            target,
            initialize,
            protocolBodyLimit,
            bodyParser<RelayHttpEnvironment, typeof catalogRequestSchema>(catalogRequestSchema),
            async (context) => {
                const useCases = context.var.relay.services.computerConnections;
                const body = context.req.valid("json");
                const agents = validateAgents(body.agents);
                await useCases.updateAgentCatalog(
                    validateIdentifier(context.req.param("computerId"), "computer_id"),
                    bearerToken(context.req.raw),
                    context.req.header(COMPUTER_SUCCESSOR_CREDENTIAL_HEADER) ?? null,
                    agents,
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            },
        );
}
