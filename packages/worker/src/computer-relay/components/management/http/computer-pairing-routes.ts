import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { authenticatedSession, localSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const pairingInput = v.strictObject({ idempotencyKey: relayIdentifier });

export function createComputerPairingRoutes() {
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
            localSession("pairComputer"),
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const session = context.get("session");
                using deadline = new RequestDeadline(context.req.raw.signal, 15000);
                const signal = deadline.signal;
                const input = context.req.valid("json");
                const pairing = await context.var.application.services.management.createComputerPairing(
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
            return json(await context.var.application.services.management.readComputerPairing(session.userId, signal));
        });
}
