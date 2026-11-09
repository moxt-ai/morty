import { RUNTIME_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { Hono } from "hono";
import {
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validatePairingCode,
} from "../../entity/pairing/pairing.ts";
import { bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import { pairingTimeoutMiddleware } from "../middleware/pairing-timeout-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createProjectRuntimePairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use("/pairings/:pairingId/redeem", pairingTimeoutMiddleware("Runtime pairing redemption timed out"))
        .use("/computers/:computerId/pairings", pairingTimeoutMiddleware("Runtime pairing creation timed out"))
        .use(
            "/computers/:computerId/pairings/:pairingId",
            pairingTimeoutMiddleware("Pairing lookup or revocation timed out"),
        )
        .post(
            "/pairings/:pairingId/redeem",
            bodyParser<RelayHttpEnvironment>(["agents", "machineName", "pairingCode", "workspaceName"]),
            async (context) => {
                const body = context.req.valid("json");
                const agents = validateAgents(body["agents"]);
                const redeemed = await context.env.services.runtimePairings.redeemRuntimePairing(
                    validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                    validatePairingCode(body["pairingCode"]),
                    validateDisplayName(body["machineName"], "machine_name"),
                    validateDisplayName(body["workspaceName"], "workspace_name"),
                    agents,
                    context.var.signal,
                );
                return context.json({
                    channelId: redeemed.channelId,
                    runtimeCredential: redeemed.daemonToken,
                    pairingId: redeemed.pairingId,
                });
            },
        )
        .get("/runtimes/connect", async (context) => {
            const request = context.req.raw;
            const connection = await context.env.services.channels.connectRuntime(
                bearerToken(request),
                request.headers.get(RUNTIME_SUCCESSOR_CREDENTIAL_HEADER) ?? "",
                request.signal,
            );
            switch (connection.kind) {
                case "accepted":
                    return await context.env.gateways.channelGateway.acceptDaemon(
                        connection.access,
                        request,
                        request.signal,
                    );
                case "revoked":
                    return context.env.gateways.channelGateway.refuseRevokedDaemon();
            }
        })
        .post(
            "/computers/:computerId/pairings",
            bodyParser<RelayHttpEnvironment>(["idempotencyKey"]),
            async (context) => {
                const request = context.req.raw;
                const body = context.req.valid("json");
                return context.json(
                    await context.env.services.runtimePairings.createProjectRuntimePairing(
                        validateIdentifier(context.req.param("computerId"), "project_id"),
                        bearerToken(request),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        context.var.signal,
                    ),
                    201,
                );
            },
        )
        .get("/computers/:computerId/pairings/:pairingId", async (context) => {
            const request = context.req.raw;
            return context.json(
                await context.env.services.runtimePairings.readProjectRuntimePairing(
                    validateIdentifier(context.req.param("computerId"), "project_id"),
                    validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                    bearerToken(request),
                    context.var.signal,
                ),
            );
        })
        .get("/computers/:computerId/pairings/:pairingId/host", async (context) => {
            const request = context.req.raw;
            const access = await context.env.services.runtimePairings.authorizePairedHost(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                bearerToken(request),
                request.signal,
            );
            return await context.env.gateways.channelGateway.acceptHost(access, request, request.signal);
        })
        .delete("/computers/:computerId/pairings/:pairingId", async (context) => {
            const request = context.req.raw;
            await context.env.services.runtimePairings.revokeProjectRuntime(
                validateIdentifier(context.req.param("computerId"), "project_id"),
                validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                bearerToken(request),
                context.var.signal,
            );
            return new Response(null, { status: 204 });
        });
}
