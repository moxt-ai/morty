import { isIdentifier } from "@morty-build/client/protocol";
import { Hono } from "hono";
import { ComputerScope } from "../../entity/do/session.ts";
import type { RuntimeAdmission, RuntimeService } from "../../service/channel/runtime-service.ts";

function unauthorized(message: string): Response {
    return Response.json({ error: { code: "unauthorized", message } }, { status: 401 });
}

export function createRuntimeRoutes(runtime: RuntimeService) {
    return new Hono().all("/computers/:computerId/*", async (c) => {
        const request = c.req.raw;
        const computerId = c.req.param("computerId");
        if (!computerId) {
            return unauthorized("Verified channel access is required");
        }
        const scope = new ComputerScope(computerId);
        const url = new URL(request.url);
        const credentialId = request.headers.get("x-morty-host-credential-id");
        if (request.method === "DELETE" && url.pathname.endsWith("/runtime/revoke")) {
            await runtime.revokeRuntime(scope, request.signal);
            return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/runtime-status")) {
            await runtime.expireSilentDaemons();
            return Response.json({ online: runtime.isOnline(computerId) });
        }
        const revoked = () =>
            Response.json(
                { error: { code: "runtime_revoked", message: "The Runtime has been revoked" } },
                { status: 401 },
            );
        const admitted = (result: RuntimeAdmission) => (result.kind === "accepted" ? result.response : revoked());
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("WebSocket upgrade required", { status: 426 });
        }
        if (url.pathname.endsWith("/daemon")) {
            return admitted(await runtime.acceptDaemon(scope, request.signal));
        }
        if (url.pathname.endsWith("/host")) {
            if (credentialId === null) {
                return unauthorized("Verified host credential access is required");
            }
            const nativeRequestId = url.searchParams.get("nativeRequestId");
            if (nativeRequestId !== null && (nativeRequestId.length === 0 || nativeRequestId.length > 128)) {
                return new Response("A bounded native request identifier is required", { status: 400 });
            }
            const harness = url.searchParams.get("harness");
            const sessionId = url.searchParams.get("sessionId");
            if ((harness !== null || sessionId !== null) && (!isIdentifier(harness) || !isIdentifier(sessionId))) {
                return new Response("A valid harness and native Session are required", { status: 400 });
            }
            const sessionFilter = harness !== null && sessionId !== null ? { harness, sessionId } : undefined;
            return admitted(
                await runtime.acceptHost(
                    {
                        role: "host",
                        credential: { credentialId },
                        computerId,
                        ...(nativeRequestId === null ? {} : { nativeRequestId }),
                        ...(sessionFilter === undefined ? {} : { sessionFilter }),
                    },
                    request.signal,
                ),
            );
        }
        if (url.pathname.endsWith("/live-history")) {
            return admitted(await runtime.acceptHost({ role: "relay", computerId }, request.signal));
        }
        return new Response(null, { status: 404 });
    });
}
