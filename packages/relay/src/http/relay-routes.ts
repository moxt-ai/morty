import { isIdentifier, MORTY_API_PREFIX, PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import { errorMiddleware, notFoundResponse, requestTimeoutMiddleware, rethrowHonoError } from "@morty-build/relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { ComputerManagementError } from "../entity/computer-management.ts";
import {
    appCredentialAuthentication,
    authenticateWith,
    type RelayAuthenticationEnvironment,
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

type RelayHttpEnvironment = RelayAuthenticationEnvironment & {
    readonly Bindings: { readonly allowedOrigins: ReadonlySet<string> };
};
function path(value: string): string {
    if (!isIdentifier(value)) {
        throw new ComputerManagementError("invalid_request", "A Relay resource identifier is invalid", 400);
    }
    return value;
}

export function createRelayControlApplication() {
    return new Hono<RelayHttpEnvironment>({ strict: false })
        .basePath(`${MORTY_API_PREFIX}/dashboard`)
        .onError(rethrowHonoError)
        .notFound(notFoundResponse)
        .use("*", errorMiddleware)
        .use(
            "*",
            requestTimeoutMiddleware<RelayHttpEnvironment>(
                OPERATION_TIMEOUT_MILLISECONDS,
                (cause) =>
                    new ComputerManagementError(
                        "relay_timeout",
                        "The Relay request timed out; its outcome may be unknown",
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
