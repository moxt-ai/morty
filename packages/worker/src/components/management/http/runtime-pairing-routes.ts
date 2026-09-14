import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { json } from "../../../infra/http.ts";
import { PlatformProjectError, platformIdentifier } from "../entity/platform-project.ts";
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
                onError: () => json({ error: { code: "INVALID_REQUEST", message: "The request is too large." } }, 413),
            }),
            authenticatedSession,
            async (context) => {
                const session = context.get("session");
                const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
                if (context.get("mediaType") !== "application/json") {
                    throw new PlatformProjectError("INVALID_REQUEST", "A JSON request is required.", 400);
                }
                let body: unknown;
                try {
                    body = await context.req.json();
                } catch (cause) {
                    signal.throwIfAborted();
                    if (cause instanceof SyntaxError) {
                        throw new PlatformProjectError("INVALID_REQUEST", "The JSON request is invalid.", 400, {
                            cause,
                        });
                    }
                    throw cause;
                }
                const input = v.parse(pairingInput, body);
                const { origin, appId } = context.env.gateways.platformProjects.configuration();
                const project = await context.env.storages.platformProjects.read(session.userId, origin, appId, signal);
                if (project === null) {
                    throw new PlatformProjectError(
                        "PROJECT_REQUIRED",
                        "Create your Project before pairing a Runtime.",
                        409,
                    );
                }
                const pairing = await context.env.gateways.platformProjects.createPairing(
                    project.projectId,
                    input.idempotencyKey,
                    signal,
                );
                context.env.logger.info(
                    {
                        event: "runtime-pairing-issued",
                        userId: session.userId,
                        projectId: project.projectId,
                        runtimeId: pairing.runtimeId,
                    },
                    "Runtime audit event",
                );
                context.header("Cache-Control", "no-store");
                return json(pairing, 201);
            },
        )
        .get("/runtime-pairings/:pairingId", authenticatedSession, async (context) => {
            const session = context.get("session");
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const pairingId = v.parse(platformIdentifier, context.req.param("pairingId"));
            const { origin, appId } = context.env.gateways.platformProjects.configuration();
            const project = await context.env.storages.platformProjects.read(session.userId, origin, appId, signal);
            if (project === null) {
                throw new PlatformProjectError(
                    "PROJECT_REQUIRED",
                    "Create your Project before pairing a Runtime.",
                    409,
                );
            }
            return json(await context.env.gateways.platformProjects.readPairing(project.projectId, pairingId, signal));
        });
}
