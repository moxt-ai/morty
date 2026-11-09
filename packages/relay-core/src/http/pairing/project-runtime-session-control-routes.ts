import { type Identifier, isIdentifier } from "@morty-build/client/protocol";
import { type Context, Hono } from "hono";
import * as v from "valibot";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import { bearerToken } from "../../infra/relay-http.ts";
import { SessionControl } from "../../service/pairing/session-control.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";
import { decodeSessionRequest, interactionResponseRequest, turnSteerRequest } from "./session-requests.ts";

const identifier = v.custom<Identifier>(isIdentifier);

function validated<TSchema extends v.GenericSchema>(schema: TSchema, value: unknown): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new PairingDirectoryError("invalid_request", "The Runtime Session request is invalid", {
            cause: result.issues,
        });
    }
    return result.output;
}

/** Session operations on the Runtime this request names, authorized by its project credential for each operation. */
export function sessionControl(context: Context<RelayHttpEnvironment>): SessionControl {
    const computerId = validated(identifier, context.req.param("computerId"));
    const token = bearerToken(context.req.raw);
    return new SessionControl(
        async (command, permission) =>
            await context.env.services.runtimePairings.requestOperationControl(
                computerId,
                token,
                command,
                permission,
                context.req.raw.signal,
            ),
        sessionTarget(context),
    );
}

export function sessionTarget(context: Context<RelayHttpEnvironment>) {
    return {
        harness: validateIdentifier(context.req.param("harness") ?? "", "harness"),
        sessionId: validateIdentifier(context.req.param("sessionId") ?? "", "session_id"),
    };
}

export function createProjectRuntimeSessionControlRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/turns/:turnId/cancel",
            async (context) => {
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                const { stopReason } = await sessionControl(context).cancelTurn(turnId);
                context.header("Cache-Control", "no-store");
                return context.json({ turnId, stopReason });
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/turns/:turnId/cancel-before-start",
            async (context) => {
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                await sessionControl(context).withdrawTurn(turnId);
                context.header("Cache-Control", "no-store");
                return context.json({ turnId });
            },
        )
        .put(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/turns/:turnId/disposition",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                decodeSessionRequest(turnSteerRequest, context.req.valid("json"));
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                await sessionControl(context).steerTurn(turnId);
                context.header("Cache-Control", "no-store");
                return context.json({ turnId });
            },
        )
        .post(
            "/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/interactions/:interactionId/responses",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = decodeSessionRequest(interactionResponseRequest, context.req.valid("json"));
                const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
                await sessionControl(context).respond(interactionId, body);
                context.header("Cache-Control", "no-store");
                return context.json({ accepted: true });
            },
        )
        .get("/computers/:computerId/daemon/harnesses/:harness/sessions/:sessionId/events-v2", async (context) => {
            const cursor = context.req.query("cursor");
            const events = await sessionControl(context).liveEvents({
                cursor:
                    cursor === undefined
                        ? null
                        : validated(v.pipe(v.string(), v.minLength(1), v.maxLength(512)), cursor),
                eventLimit: validated(
                    v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                    Number(context.req.query("limit") ?? "50"),
                ),
            });
            context.header("Cache-Control", "no-store");
            return context.json(events);
        });
}
