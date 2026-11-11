import { isIdentifier } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import { ComputerScope } from "../../../../contracts/relay/session.ts";
import type { ComputerAdmission, ComputerService } from "../service/computer-service.ts";

type Environment = { readonly Variables: { readonly scope: ComputerScope } };
const webSocketUpgrade: MiddlewareHandler<Environment> = async (context, next) => {
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
    }
    return await next();
};
const revoked = () =>
    Response.json({ error: { code: "computer_revoked", message: "The Computer has been revoked" } }, { status: 401 });
const admitted = (result: ComputerAdmission) => (result.kind === "accepted" ? result.response : revoked());

/** These routes are reachable only through the deployment's Durable Object capability. */
export function createComputerRoutes(ctx: { readonly services: { readonly runtime: ComputerService } }) {
    return new Hono<Environment>()
        .basePath("/computers/:computerId")
        .use("*", async (context, next) => {
            context.set("scope", new ComputerScope(validateIdentifier(context.req.param("computerId"), "computer_id")));
            await next();
        })
        .delete("/computer/revoke", async (context) => {
            await ctx.services.runtime.revokeComputer(context.var.scope, context.req.raw.signal);
            return new Response(null, { status: 204 });
        })
        .get("/computer-status", async (context) => {
            return Response.json(await ctx.services.runtime.readStatus(context.var.scope, context.req.raw.signal));
        })
        .get("/daemon", webSocketUpgrade, async (context) => {
            return admitted(await ctx.services.runtime.acceptDaemon(context.var.scope, context.req.raw.signal));
        })
        .get("/host", webSocketUpgrade, async (context) => {
            const nativeRequestId = context.req.query("nativeRequestId");
            if (nativeRequestId !== undefined && (nativeRequestId.length === 0 || nativeRequestId.length > 128)) {
                return new Response("A bounded native request identifier is required", { status: 400 });
            }
            const harness = context.req.query("harness");
            const sessionId = context.req.query("sessionId");
            if (
                (harness !== undefined || sessionId !== undefined) &&
                (!isIdentifier(harness) || !isIdentifier(sessionId))
            ) {
                return new Response("A valid harness and native Session are required", { status: 400 });
            }
            return admitted(
                await ctx.services.runtime.acceptHost(
                    {
                        role: "host",
                        computerId: context.var.scope.computerId,
                        ...(nativeRequestId === undefined ? {} : { nativeRequestId }),
                        ...(harness === undefined || sessionId === undefined
                            ? {}
                            : { sessionFilter: { harness, sessionId } }),
                    },
                    context.req.raw.signal,
                ),
            );
        });
}
