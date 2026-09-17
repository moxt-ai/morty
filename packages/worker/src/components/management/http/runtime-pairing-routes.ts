import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { ManagementError } from "../entity/management-error.ts";
import { platformIdentifier } from "../entity/platform-project.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const pairingInput = v.strictObject({ idempotencyKey: platformIdentifier });

export function createRuntimePairingRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .use("/runtime-pairings/*", async (context, next) => {
            context.header("Cache-Control", "no-store");
            await next();
        })
        .post(
            "/runtime-pairings",
            bodyLimit({
                maxSize: 4096,
                onError: () => {
                    throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
                },
            }),
            authenticatedSession,
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const session = context.get("session");
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
                const input = context.req.valid("json");
                const pairing = await context.env.services.management.createRuntimePairing(
                    session.userId,
                    input.idempotencyKey,
                    signal,
                );
                context.header("Cache-Control", "no-store");
                return json(pairing, 201);
            },
        )
        .get("/runtime-pairings/:pairingId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const pairingId = v.parse(platformIdentifier, context.req.param("pairingId"));
            return json(await context.env.services.management.readRuntimePairing(session.userId, pairingId, signal));
        });
}
