import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { computerObject } from "../../../gateway/computer-object-routing.ts";
import { json } from "../../../infra/http.ts";
import { ManagementError } from "../entity/management-error.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createComputerManagementRoutes() {
    return new Hono<ManagementHttpEnvironment>()
        .use(
            "/computer",
            bodyLimit({
                maxSize: 4096,
                onError: () => {
                    throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
                },
            }),
        )
        .get("/computer", authenticatedSession, async (context) => {
            const session = context.get("session");
            return json({
                computer: await context.env.services.management.readProject(
                    session.userId,
                    AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15000)]),
                ),
            });
        })
        .post("/computer/replacement", async (context) => {
            const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(45000)]);
            const { authentication, management } = context.env.services;
            const local = await authentication.authorize(context.get("bearerToken"), "replaceProject", signal);
            switch (local.kind) {
                case "unauthenticated":
                case "revoked":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the identity saved on the machine to replace its Project.",
                        403,
                    );
                case "authorized":
                    break;
            }
            // This optional correlation ID is untrusted diagnostics, never authorization.
            const setupRunId = v.safeParse(v.pipe(v.string(), v.uuid()), context.req.header("x-morty-setup-run-id"));
            const audit = {
                event: "project_replacement",
                previousComputerId: context.env.config.bindings.CHAT_COMPUTER_ID,
                setupRunId: setupRunId.success ? setupRunId.output : null,
            };
            context.env.logger.info({ ...audit, stage: "requested" }, "Project replacement requested");
            try {
                const project = await management.replaceProject(local.credential.userId, signal);
                // Repeating the same saved local identity reuses its successor credential, even if bootstrap
                // committed only part of its data. An explicitly revoked successor credential is never reissued.
                const response = await computerObject(context.env.config.bindings, project.computerId).fetch(
                    new Request("https://computer.internal/__computer/bootstrap", {
                        body: JSON.stringify({
                            computer: project,
                            userId: local.credential.userId,
                            origin: {
                                kind: "replacement",
                                previousComputerId: audit.previousComputerId,
                                token: local.token,
                            },
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal,
                    }),
                );
                signal.throwIfAborted();
                if (!response.ok) {
                    context.env.logger.warn(
                        {
                            ...audit,
                            computerId: project.computerId,
                            stage: "bootstrap_failed",
                            status: response.status,
                        },
                        "Project replacement did not reach access revocation",
                    );
                    return response;
                }
                // Keep the local identity until setup has saved the successor, so a lost reply can be retried.
                const revoked = await authentication.revokeOtherAccess(local.token, signal);
                if (revoked.kind !== "revoked") {
                    throw new ManagementError("UNAUTHENTICATED", "Local identity is no longer available.", 401);
                }
                context.env.logger.info(
                    { ...audit, computerId: project.computerId, stage: "access_revoked" },
                    "Earlier shared access revoked by Project replacement",
                );
                return response;
            } catch (cause) {
                // Do not log request bodies, credentials, or arbitrary remote error messages. A failed response
                // cannot prove whether a request already changed access, so leave the outcome unconfirmed.
                context.env.logger.warn(
                    { ...audit, stage: "outcome_unconfirmed" },
                    "Project replacement did not return a confirmed result",
                );
                throw cause;
            }
        });
}
