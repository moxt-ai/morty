import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { RequestDeadline } from "../../../infra/request-deadline.ts";
import { bodyParser } from "../../../middleware/body-parser.ts";
import { relayIdentifier } from "../entity/computer-management.ts";
import { ManagementError } from "../entity/management-error.ts";
import { authenticatedSession, localSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const pairingInput = v.strictObject({ idempotencyKey: relayIdentifier });

export function createRuntimePairingRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .use("/pairing", async (context, next) => {
            context.header("Cache-Control", "no-store");
            await next();
        })
        .post(
            "/pairing",
            bodyLimit({
                maxSize: 4096,
                onError: () => {
                    throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
                },
            }),
            localSession("pairRuntime"),
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const session = context.get("session");
                using deadline = new RequestDeadline(context.req.raw.signal, 15000);
                const signal = deadline.signal;
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
        .get("/pairing", authenticatedSession, async (context) => {
            const session = context.get("session");
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            const signal = deadline.signal;
            return json(await context.env.services.management.readRuntimePairing(session.userId, signal));
        });
}
