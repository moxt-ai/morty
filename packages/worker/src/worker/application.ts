import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { credentialRevocationPaths } from "../contracts/authentication/credential.ts";
import { clientLocationHeader, clientLocationOf, encodeClientLocation } from "../contracts/client-location.ts";
import type { CloudBindings } from "../contracts/cloud-bindings.ts";
import { relayAuthenticationFromEnvironment } from "../contracts/relay-authentication-environment.ts";
import { relayBindings } from "../contracts/relay-bindings.ts";
import { computerFromPath, computerFromRuntimeCredential, computerFromTransfer } from "../http/computer-target.ts";
import { errorHandler } from "../http/error-middleware.ts";
import { RequestError } from "../http/request-error.ts";
import { logger } from "../infra/logger.ts";
import { errorMiddleware, relayErrorHandler } from "../middleware/error-middleware.ts";
import { requestTimeoutMiddleware } from "../middleware/request-timeout-middleware.ts";
import { instructionDocumentRoutes } from "./components/instruction-documents/http/index.ts";
import { cloudRoutes } from "./composition/cloud-http.ts";
import { forwardToComputer } from "./gateway/computer-object-routing.ts";
import { notFoundPage, webPages } from "./http/web-pages.ts";

const MAXIMUM_REQUEST_BODY_BYTES = 3 * 1_024 * 1_024;

type ForwardingEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly signal: AbortSignal; readonly computerId?: string };
};

/** Worker dispatch only. The owning DO defines and authorizes the actual endpoints. */
function createComputerForwardingRoutes() {
    const forward: MiddlewareHandler<ForwardingEnvironment> = async (context) => {
        const computerId = context.var.computerId;
        if (computerId === undefined) {
            throw new RequestError("NOT_FOUND", "Not found.", 404);
        }
        const authentication = relayAuthenticationFromEnvironment(relayBindings(context.env));
        const origin = context.req.header("origin");
        if (
            origin !== undefined &&
            !authentication.allowedOrigins.has("*") &&
            !authentication.allowedOrigins.has(origin)
        ) {
            return context.json(
                { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
                403,
            );
        }
        return await forwardToComputer(context.req.raw, context.env, computerId);
    };
    const timeout = requestTimeoutMiddleware<ForwardingEnvironment>(30_000);
    const location: MiddlewareHandler<ForwardingEnvironment> = async (context, next) => {
        const headers = new Headers(context.req.raw.headers);
        const location = clientLocationOf(context.req.raw);
        headers.delete(clientLocationHeader);
        if (location !== null) {
            headers.set(clientLocationHeader, encodeClientLocation(location));
        }
        context.req.raw = new Request(context.req.raw, { headers });
        await next();
    };
    return (
        new Hono<ForwardingEnvironment>()
            .onError(relayErrorHandler)
            .use("*", errorMiddleware, timeout)
            .get("/morty/api/v1/computers/connect", computerFromRuntimeCredential, forward)
            .post("/morty/api/v1/pairings/:computerId/redeem", computerFromPath, forward)
            .put("/morty/api/channels/:computerId/catalog", computerFromPath, forward)
            .get("/morty/api/v1/computers/:computerId/transport", computerFromPath, forward)
            .on(
                ["GET", "OPTIONS"],
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content",
                computerFromPath,
                forward,
            )
            // These retired HTTP operations retain their typed Relay 404; Session commands use WebSocket only.
            .all(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/configuration",
                computerFromPath,
                forward,
            )
            .all(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/active-turn",
                computerFromPath,
                forward,
            )
            .all(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/events-v2",
                computerFromPath,
                forward,
            )
            .all(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/interactions",
                computerFromPath,
                forward,
            )
            .all(
                "/morty/api/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/turns",
                computerFromPath,
                forward,
            )
            .post("/morty/api/identity/transfers/redeem", location, computerFromTransfer, forward)
            .post("/morty/api/computers/:computerId/identity/link", computerFromPath, forward)
            .all("/morty/api/computers/:computerId/session", computerFromPath, forward)
            .post("/morty/api/computers/:computerId/identity/transfers", computerFromPath, forward)
            .post("/morty/api/computers/:computerId/identity/transfers/redeem", computerFromPath, forward)
            .post("/morty/api/computers/:computerId/identity/recovery-token", computerFromPath, forward)
            .get("/morty/api/computers/:computerId/identity/devices", computerFromPath, forward)
            .post("/morty/api/computers/:computerId/identity/revoke-all-access", computerFromPath, forward)
            .delete("/morty/api/computers/:computerId/identity/v1/other-browser-access", computerFromPath, forward)
            .delete("/morty/api/computers/:computerId/identity/v1/devices/:deviceId", computerFromPath, forward)
            .delete(`/morty/api/computers/:computerId${credentialRevocationPaths.browser}`, computerFromPath, forward)
            .delete(`/morty/api/computers/:computerId${credentialRevocationPaths.recovery}`, computerFromPath, forward)
            .delete(`/morty/api/computers/:computerId${credentialRevocationPaths.local}`, computerFromPath, forward)
            .get("/morty/api/computers/:computerId/management/computer/pairing-state", computerFromPath, forward)
            .get("/morty/api/computers/:computerId/management/computer", computerFromPath, forward)
            .post("/morty/api/computers/:computerId/management/computer/replacement", computerFromPath, forward)
            .on(["GET", "POST"], "/morty/api/computers/:computerId/management/pairing", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/workspace", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/daemon-diagnostics", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/network-diagnostic", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/setup/computers", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/workspace/directory", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/managed-sessions", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/agent-settings", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/access", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/session-access", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/managed-session", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/managed-session/archive", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/native-sessions", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/continue-native-session", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/native-session/:id", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/native-session/:id/import", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/native-session-forks/:operationId", computerFromPath, forward)
            .post("/morty/api/chat/computers/:computerId/setup", computerFromPath, forward)
    );
}

const notFound = (): never => {
    throw new RequestError("NOT_FOUND", "Not found.", 404);
};

const publicApplication = new Hono<{ readonly Bindings: CloudBindings }>()
    .onError(errorHandler<{ readonly Bindings: CloudBindings }>(() => logger))
    .get("/morty/api/health", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES }), (context) => context.body(null, 204))
    .route("/", webPages)
    .route("/", instructionDocumentRoutes)
    .route("/morty/api", cloudRoutes)
    .route("/", createComputerForwardingRoutes())
    .notFound((context) => notFoundPage(context.req.raw) ?? notFound());

export async function fetchPublicApplication(
    request: Request,
    bindings: CloudBindings,
    context?: ExecutionContext,
): Promise<Response> {
    return await publicApplication.fetch(request, bindings, context);
}

export default { fetch: fetchPublicApplication } satisfies ExportedHandler<CloudBindings, unknown>;
