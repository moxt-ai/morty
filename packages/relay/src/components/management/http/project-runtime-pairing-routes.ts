import { RUNTIME_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import type { RelayHttpEnvironment } from "../../../composition/relay-protocol-environment.ts";
import { bearerToken } from "../../../infra/relay-http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../../../middleware/error-middleware.ts";
import { pairingTimeoutMiddleware } from "../../../middleware/pairing-timeout-middleware.ts";
import { validateAgents, validateDisplayName, validateIdentifier, validatePairingCode } from "../entity/pairing.ts";

export function createProjectRuntimePairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use("/pairings/:computerId/redeem", pairingTimeoutMiddleware("Runtime pairing redemption timed out"))
        .post(
            "/pairings/:computerId/redeem",
            bodyParser<RelayHttpEnvironment>(["agents", "machineName", "pairingCode", "workspaceName"]),
            async (context) => {
                const body = context.req.valid("json");
                const agents = validateAgents(body["agents"]);
                const redeemed = await context.var.relay.services.runtimePairings.redeemRuntimePairing(
                    validateIdentifier(context.req.param("computerId"), "computer_id"),
                    validatePairingCode(body["pairingCode"]),
                    validateDisplayName(body["machineName"], "machine_name"),
                    validateDisplayName(body["workspaceName"], "workspace_name"),
                    agents,
                    context.var.signal,
                );
                return context.json({
                    computerId: redeemed.computerId,
                    runtimeCredential: redeemed.daemonToken,
                });
            },
        )
        .get("/runtimes/connect", async (context) => {
            const request = context.req.raw;
            const connection = await context.var.relay.services.channels.connectRuntime(
                bearerToken(request),
                request.headers.get(RUNTIME_SUCCESSOR_CREDENTIAL_HEADER) ?? "",
                request.signal,
            );
            switch (connection.kind) {
                case "accepted":
                    return await context.var.relay.gateways.channelGateway.acceptDaemon(
                        connection.access,
                        request,
                        request.signal,
                    );
                case "revoked":
                    return context.var.relay.gateways.channelGateway.refuseRevokedDaemon();
            }
        });
}
