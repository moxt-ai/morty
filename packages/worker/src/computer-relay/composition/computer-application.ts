import { Hono, type MiddlewareHandler } from "hono";
import type { ComputerApplication } from "../../contracts/computer-application.ts";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import { WebSocketDispatchError, type WebSocketHttpOperation } from "../../contracts/websocket-http-dispatch.ts";
import { errorHandler } from "../../http/error-middleware.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { createChatApplication } from "../components/chat/http/index.ts";
import { createTransferRedemptionRoutes } from "../components/management/http/authentication-routes.ts";
import { createManagementApplication } from "../components/management/http/index.ts";
import type { ManagementHttpEnvironment } from "../components/management/http/management-http-environment.ts";
import { sessionContentUploadRequired } from "../components/runtime/http/session-content-upload.ts";
import { BrowserUploadCapacity } from "../components/runtime/service/browser-upload-capacity.ts";
import {
    type BrowserSessionServices,
    createBrowserWebSocketRoutes,
} from "../components/runtime/websocket/browser-websocket-routes.ts";
import { logger } from "./application-context.ts";
import type { ComputerRouteContext } from "./computer-route-context.ts";

type BrowserApplicationEnvironment = {
    readonly Bindings: ConfiguredRelayBindings & { readonly operation: WebSocketHttpOperation };
};

/** HTTP and WebSocket have independent route trees; only application behavior is shared. */
export function createComputerApplication(
    ctx: ComputerRouteContext,
    sessionServices: (computerId: string) => BrowserSessionServices,
): ComputerApplication {
    const uploads = new BrowserUploadCapacity();
    const initialize: MiddlewareHandler<ManagementHttpEnvironment> = async (context, next) => {
        using deadline = new RequestDeadline(context.req.raw.signal, 20_000);
        context.set(
            "application",
            await ctx.services.browser.forComputer(context.var.computerId, ctx.bindings, deadline.signal),
        );
        await next();
    };
    const http = new Hono<ManagementHttpEnvironment>()
        .onError(errorHandler<ManagementHttpEnvironment>(() => logger))
        .route("/morty/api/chat/computers/:computerId", createChatApplication(initialize))
        .route("/morty/api/computers/:computerId", createManagementApplication(initialize))
        .route("/morty/api", createTransferRedemptionRoutes(initialize))
        .notFound(() =>
            Response.json(
                { error: { code: "not_found", message: "The requested Morty resource does not exist" } },
                { status: 404 },
            ),
        );

    return {
        http: async (request) => await http.fetch(request, ctx.bindings),
        browser: (computerId) => {
            const prepareApplicationRequest: MiddlewareHandler<BrowserApplicationEnvironment> = async (
                context,
                next,
            ) => {
                if (context.req.param("computerId") !== computerId) {
                    throw new WebSocketDispatchError();
                }
                const operation = context.env.operation;
                if (operation.kind === "upload-admission") {
                    return sessionContentUploadRequired();
                }
                context.req.raw = new Request(context.req.raw, {
                    signal: AbortSignal.any([context.req.raw.signal, operation.enableCancellation()]),
                });
                await next();
                return;
            };
            const chat = new Hono<BrowserApplicationEnvironment>()
                // CLI setup remains HTTP-only, including its established transport rejection.
                .all("/setup", () => {
                    throw new WebSocketDispatchError();
                })
                .use("*", prepareApplicationRequest)
                .route("/", createChatApplication(initialize));
            const management = new Hono<BrowserApplicationEnvironment>()
                .use("*", prepareApplicationRequest)
                .route("/", createManagementApplication(initialize));
            const browser = new Hono<BrowserApplicationEnvironment>()
                .onError((cause) => {
                    throw cause;
                })
                .route("/morty/api/chat/computers/:computerId", chat)
                .route("/morty/api/computers/:computerId", management)
                .route("/", createBrowserWebSocketRoutes({ computerId, services: sessionServices(computerId) }))
                .notFound(() => {
                    throw new WebSocketDispatchError();
                });

            return async (operation) => {
                const response = await browser.fetch(operation.request, { ...ctx.bindings, operation });
                if (operation.kind === "upload-admission" && response.ok) {
                    uploads.reserve(operation.byteLength, operation.request.signal);
                }
                if (response.status === 101) {
                    await ctx.utilities.connectionOpened();
                }
                return response;
            };
        },
    };
}
