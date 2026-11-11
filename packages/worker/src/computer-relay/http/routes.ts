import { decodeFileReadCommand, MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { computerRequestTarget } from "@morty-build/client/relay";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { COMPUTER_INTERNAL_PREFIX } from "../../contracts/computer-relay-http.ts";
import { ManagementError } from "../../contracts/management-error.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { readJsonBody } from "../../http/body-parser.ts";
import { computerFromPath, computerFromTransfer } from "../../http/computer-target.ts";
import { errorHandler } from "../../http/error-middleware.ts";
import { json } from "../../http/json.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { createBrowserCors } from "../../middleware/browser-cors.ts";
import { createChatApplication } from "../components/chat/http/index.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { ManagementHttpEnvironment } from "../components/management/http/management-http-environment.ts";
import { createRelayProtocolRoutes } from "../components/management/http/protocol-routes.ts";
import { sessionAccessTargetMiddleware } from "../components/runtime/http/session-access-target.ts";
import { authorizeSessionContentUpload } from "../components/runtime/http/session-content-upload.ts";
import { decodeSessionRequest } from "../components/runtime/http/session-requests.ts";
import { acceptWebSocketHttpTransport } from "../components/runtime/http/websocket-http-transport.ts";
import { createBrowserWebSocketRoutes } from "../components/runtime/websocket/browser-websocket-routes.ts";
import { logger } from "../composition/application-context.ts";
import type { ComputerRouteContext } from "../composition/computer-route-context.ts";
import type { ComputerRouteHttpEnvironment } from "./environment.ts";

/** ComputerRelay HTTP endpoints and connection upgrades. Session commands stay inside the WS dispatchers. */
export function createComputerHttpRoutes(ctx: ComputerRouteContext) {
    const filePath = `${MORTY_API_PREFIX}/v1/computers/:computerId/harnesses/:harness/sessions/:sessionId/files/content`;
    return new Hono<ComputerRouteHttpEnvironment>()
        .use(`${COMPUTER_INTERNAL_PREFIX}/*`, bodyLimit({ maxSize: 3 * 1_024 * 1_024 }))
        .get(`${COMPUTER_INTERNAL_PREFIX}/:computerId/account`, async (context) =>
            context.json(await context.var.computerInternal.readAccount(context.req.raw.signal)),
        )
        .post(`${COMPUTER_INTERNAL_PREFIX}/:computerId/account`, async (context) =>
            context.json(
                await context.var.computerInternal.createAccount(
                    await readJsonBody(context.req.raw),
                    context.req.raw.signal,
                ),
            ),
        )
        .get(`${COMPUTER_INTERNAL_PREFIX}/:computerId/active-generation`, async (context) =>
            context.json({
                generation: await context.var.computerInternal.readActiveGeneration(context.req.raw.signal),
            }),
        )
        .post(`${COMPUTER_INTERNAL_PREFIX}/:computerId/access-check`, async (context) =>
            context.json({
                holdsAccess: await context.var.computerInternal.holdsAccess(
                    await readJsonBody(context.req.raw),
                    context.req.raw.signal,
                ),
            }),
        )
        .post(`${COMPUTER_INTERNAL_PREFIX}/:computerId/audit-events`, async (context) => {
            await context.var.computerInternal.recordAudit(await readJsonBody(context.req.raw), context.req.raw.signal);
            return new Response(null, { status: 204 });
        })
        .route("/", createRelayProtocolRoutes())
        .post("/__computer/bootstrap", async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45_000);
            const input: unknown = await context.req.json();
            return json(await ctx.services.browser.bootstrap(input, ctx.bindings, deadline.signal), 201);
        })
        .get(`${MORTY_API_PREFIX}/v1/computers/:computerId/transport`, (context) => {
            const computerId = context.req.param("computerId");
            const sessionAccess = context.var.sessionAccess;
            const dispatchBrowserMessage = createBrowserWebSocketRoutes({
                computerId,
                services: { sessions: sessionAccess, operations: context.var.sessionOperations },
            });
            return acceptWebSocketHttpTransport({
                request: context.req.raw,
                dispatch: async (operation) => {
                    const response = await dispatchBrowserMessage(operation);
                    if (response.status === 101) {
                        await ctx.utilities.connectionOpened();
                    }
                    return response;
                },
                uploads: ctx.resources.uploads,
                authorizeUpload: async (operation) => {
                    const authorized = await authorizeSessionContentUpload(operation, sessionAccess);
                    return authorized instanceof Response ? authorized : new Response(null, { status: 204 });
                },
                validateTarget: (operation) => {
                    const target = computerRequestTarget(operation);
                    return target?.kind === "operation" && target.computerId === computerId;
                },
            });
        })
        .use(filePath, createBrowserCors(["GET"], ["authorization"]))
        .get(filePath, sessionAccessTargetMiddleware, async (context) => {
            const credential = (context.req.header("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
            if (credential === undefined) {
                return context.json(
                    { error: { code: "session_access_required", message: "A Session credential is required" } },
                    401,
                );
            }
            const access = await context.var.sessionAccess.authorizeLiveEvents(
                context.var.sessionAccessTarget,
                credential,
                context.req.raw.signal,
            );
            const path = decodeSessionRequest(
                v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
                context.req.query("path"),
            );
            const maxBytes = decodeSessionRequest(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(128 * 1024 * 1024)),
                Number(context.req.query("maxBytes") ?? String(32 * 1024 * 1024)),
            );
            return context.var.sessionOperations.readProjectSessionFile(
                access.computerId,
                decodeFileReadCommand(
                    JSON.stringify({
                        kind: "file.read",
                        maxBytes,
                        path,
                        requestId: crypto.randomUUID(),
                        target: {
                            harness: validateIdentifier(context.req.param("harness"), "harness"),
                            sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                        },
                    }),
                ),
                context.req.raw.signal,
            );
        })
        .all("/morty/api/v1/computers/:computerId/harnesses/*", () =>
            Response.json(
                { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                { status: 404 },
            ),
        )
        .route("/", createApplicationRoutes(ctx));
}

function createApplicationRoutes(ctx: ComputerRouteContext) {
    const initialize: MiddlewareHandler<ManagementHttpEnvironment> = async (context, next) => {
        const computerId = context.get("computerId");
        using deadline = new RequestDeadline(context.req.raw.signal, 20_000);
        context.set("application", await ctx.services.browser.forComputer(computerId, ctx.bindings, deadline.signal));
        await next();
    };
    const sizeLimit = bodyLimit({ maxSize: 3 * 1_024 * 1_024 });
    return new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler<ManagementHttpEnvironment>(() => logger))
        .post("/morty/api/computers/:computerId/identity/transfers/redeem", () => {
            throw new ManagementError("NOT_FOUND", "Not found.", 404);
        })
        .use("/morty/api/computers/:computerId/*", computerFromPath, sizeLimit, initialize)
        .use("/morty/api/chat/computers/:computerId/*", computerFromPath, sizeLimit, initialize)
        .use("/morty/api/identity/transfers/redeem", computerFromTransfer, sizeLimit, initialize)
        .route("/morty/api/chat/computers/:computerId", createChatApplication())
        .route("/morty/api/computers/:computerId", createManagementApplication())
        .route("/morty/api", createManagementApplication());
}
