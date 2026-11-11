import { isIdentifier } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { validateIdentifier } from "../../management/entity/pairing.ts";
import { ComputerScope } from "../entity/session.ts";
import type { RuntimeAdmission, RuntimeService } from "../service/runtime-service.ts";

type Environment = { readonly Variables: { readonly scope: ComputerScope } };
const webSocketUpgrade: MiddlewareHandler<Environment> = async (context, next) => {
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
    }
    return await next();
};
const revoked = () =>
    Response.json({ error: { code: "runtime_revoked", message: "The Runtime has been revoked" } }, { status: 401 });
const admitted = (result: RuntimeAdmission) => (result.kind === "accepted" ? result.response : revoked());

/** These routes are reachable only through the deployment's Durable Object capability. */
export function createRuntimeRoutes(runtime: RuntimeService) {
    return new Hono<Environment>()
        .basePath("/computers/:computerId")
        .use("*", async (context, next) => {
            context.set("scope", new ComputerScope(validateIdentifier(context.req.param("computerId"), "computer_id")));
            await next();
        })
        .delete("/runtime/revoke", async (context) => {
            await runtime.revokeRuntime(context.var.scope, context.req.raw.signal);
            return new Response(null, { status: 204 });
        })
        .get("/runtime-status", async (context) => {
            await runtime.expireSilentDaemons();
            return Response.json({ online: runtime.isOnline(context.var.scope.computerId) });
        })
        .get("/daemon", webSocketUpgrade, async (context) => {
            return admitted(await runtime.acceptDaemon(context.var.scope, context.req.raw.signal));
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
                await runtime.acceptHost(
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
        })
        .get("/live-history", webSocketUpgrade, async (context) =>
            admitted(
                await runtime.acceptHost(
                    {
                        role: "relay",
                        computerId: context.var.scope.computerId,
                    },
                    context.req.raw.signal,
                ),
            ),
        );
}
