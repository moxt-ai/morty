import { isIdentifier, MORTY_API_PREFIX, PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import { errorMiddleware, notFoundResponse, requestTimeoutMiddleware, rethrowHonoError } from "@morty-build/relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import {
    appCredentialAuthentication,
    authenticateWith,
    type PlatformAuthenticationEnvironment,
} from "../middleware/authentication.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { createBrowserCors } from "../middleware/browser-cors.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;
const requiredString = v.pipe(v.string(), v.minLength(1));
const createProjectBody = v.strictObject({
    displayName: requiredString,
    idempotencyKey: requiredString,
    clientReference: v.optional(v.string(), ""),
    locationHint: v.picklist(PROJECT_LOCATION_HINTS),
});

type PlatformHttpEnvironment = PlatformAuthenticationEnvironment & {
    readonly Bindings: { readonly allowedOrigins: ReadonlySet<string> };
};
function path(value: string): string {
    if (!isIdentifier(value)) {
        throw new PlatformControlPlaneError("invalid_request", "A Platform resource identifier is invalid", 400);
    }
    return value;
}

export function createPlatformControlApplication() {
    return new Hono<PlatformHttpEnvironment>({ strict: false })
        .basePath(`${MORTY_API_PREFIX}/dashboard`)
        .onError(rethrowHonoError)
        .notFound(notFoundResponse)
        .use("*", errorMiddleware)
        .use(
            "*",
            requestTimeoutMiddleware<PlatformHttpEnvironment>(
                OPERATION_TIMEOUT_MILLISECONDS,
                (cause) =>
                    new PlatformControlPlaneError(
                        "platform_timeout",
                        "The Platform request timed out; its outcome may be unknown",
                        504,
                        { cause },
                    ),
            ),
        )
        .use("*", createBrowserCors(["GET", "POST"], ["authorization", "content-type"]))
        .get("/health", (context) => context.json({ service: "morty-relay", status: "ok" }))
        .get("/v1/computers/:computerId/storage-placement", (context) =>
            context.json(
                context.env.control.resolveProjectPlacement(path(context.req.param("computerId")), context.var.signal),
            ),
        )
        .post(
            "/v1/machine-accounts",
            bodyParser(createProjectBody),
            authenticateWith(appCredentialAuthentication),
            async (context) => {
                const value = context.req.valid("json");
                return context.json(
                    await context.env.control.provisionMachineAccount(
                        context.var.principal,
                        value.displayName,
                        value.idempotencyKey,
                        value.clientReference,
                        value.locationHint,
                        context.var.signal,
                    ),
                    201,
                );
            },
        );
}
