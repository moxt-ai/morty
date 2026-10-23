import { Hono } from "hono";
import * as v from "valibot";
import { projectObject } from "../../../gateway/project-object-routing.ts";
import { json } from "../../../infra/http.ts";
import { bodyParser, readJsonBody } from "../../../middleware/body-parser.ts";
import { ManagementError } from "../entity/management-error.ts";
import { projectLocationHint } from "../util/project-location.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const transferInput = v.pipe(v.object({ code: v.string() }), v.readonly());
const anonymousUserInput = v.strictObject({
    locationHint: v.optional(
        v.picklist(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]),
    ),
});

export function createAuthenticationRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .all("/session", async (context) => {
            const request = context.req.raw;
            if (request.method !== "GET") {
                throw new ManagementError("METHOD_NOT_ALLOWED", "Method not allowed.", 405, {
                    Allow: "GET",
                });
            }
            const token = context.get("bearerToken");
            const result = await context.env.services.authentication.session(token, request.signal);
            switch (result.kind) {
                case "authenticated":
                    return json(result.session);
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
        })
        .post("/identity/anonymous-users", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
            const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
            const requestedLocation =
                contentType === "application/json"
                    ? v.parse(anonymousUserInput, await readJsonBody(request))
                    : undefined;
            signal.throwIfAborted();
            const userId = `usr_${crypto.randomUUID()}`;
            const project = await context.env.gateways.platformProjects.create(
                userId,
                "Morty",
                signal,
                requestedLocation?.locationHint ?? projectLocationHint(request),
            );
            const response = await projectObject(context.env.config.bindings, project.projectId).fetch(
                new Request("https://project.internal/__project/bootstrap", {
                    body: JSON.stringify({ project, userId }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
            signal.throwIfAborted();
            return response;
        })
        .post("/identity/transfers", async (context) => {
            const transfer = await context.env.services.authentication.createTransfer(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            if (transfer === null) {
                throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
            }
            const url = new URL(
                "/continue",
                v.parse(v.pipe(v.string(), v.url()), context.env.config.bindings.APP_ORIGIN),
            );
            url.hash = `code=${transfer.code}`;
            return json({ expiresAt: new Date(transfer.expiresAt).toISOString(), url: url.toString() }, 201);
        })
        .post("/identity/recovery-token", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]);
            const token = await context.env.services.authentication.createRecoveryToken(
                context.get("bearerToken"),
                signal,
            );
            if (token === null) {
                throw new ManagementError("UNAUTHENTICATED", "Anonymous identity is required.", 401);
            }
            return json({ token }, 201, { "Cache-Control": "no-store" });
        })
        .post(
            "/identity/transfers/redeem",
            bodyParser<ManagementHttpEnvironment, typeof transferInput>(transferInput),
            async (context) => {
                const input = context.req.valid("json");
                const identity = await context.env.services.management.redeemTransfer(
                    input.code,
                    context.req.raw.signal,
                );
                if (identity === null) {
                    throw new ManagementError(
                        "TRANSFER_UNAVAILABLE",
                        "This transfer link has expired or been revoked.",
                        410,
                    );
                }
                return json(identity);
            },
        )
        .post("/identity/revoke-all-access", async (context) => {
            const result = await context.env.services.authentication.revokeAllAccess(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "revoked":
                    return json({ status: "access_revoked" }, 200, { "Cache-Control": "no-store" });
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Local identity is required.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the original identity saved on the machine to revoke all access.",
                        403,
                    );
            }
        })
        .delete("/identity/remote-access", async (context) => {
            const result = await context.env.services.authentication.endRemoteAccess(
                context.get("bearerToken"),
                context.req.raw.signal,
            );
            switch (result.kind) {
                case "ended-credential":
                case "ended-transfer":
                    return new Response(null, { status: 204 });
                case "unauthenticated":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
            }
        });
}
