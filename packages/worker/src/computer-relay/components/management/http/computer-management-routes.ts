import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { relayBindings } from "../../../../contracts/relay-bindings.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { ComputerRelayGateway } from "../../../gateway/computer-relay.ts";
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
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            return json({
                computer: await context.var.application.services.management.readProject(
                    session.userId,
                    deadline.signal,
                ),
            });
        })
        .post("/computer/replacement", async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            const signal = deadline.signal;
            const { authentication, management } = context.var.application.services;
            const local = await authentication.authorize(context.get("bearerToken"), "replaceProject", signal);
            switch (local.kind) {
                case "unauthenticated":
                case "revoked":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the identity saved on the computer to replace its Project.",
                        403,
                    );
                case "authorized":
                    break;
            }
            // This optional correlation ID is untrusted diagnostics, never authorization.
            const setupRunId = v.safeParse(v.pipe(v.string(), v.uuid()), context.req.header("x-morty-setup-run-id"));
            const audit = {
                event: "project_replacement",
                previousComputerId: context.var.application.identity.computerId,
                setupRunId: setupRunId.success ? setupRunId.output : null,
            };
            context.var.application.logger.info({ ...audit, stage: "requested" }, "Project replacement requested");
            try {
                const project = await management.replaceProject(local.credential.userId, signal);
                // Repeating the same saved local identity reuses its successor credential, even if bootstrap
                // committed only part of its data. An explicitly revoked successor credential is never reissued.
                const response = await new ComputerRelayGateway(
                    relayBindings(context.var.application.config.bindings),
                    project.computerId,
                ).bootstrap(
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
                    context.var.application.logger.warn(
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
                context.var.application.logger.info(
                    { ...audit, computerId: project.computerId, stage: "access_revoked" },
                    "Earlier shared access revoked by Project replacement",
                );
                return response;
            } catch (cause) {
                // Do not log request bodies, credentials, or arbitrary remote error messages. A failed response
                // cannot prove whether a request already changed access, so leave the outcome unconfirmed.
                context.var.application.logger.warn(
                    { ...audit, stage: "outcome_unconfirmed" },
                    "Project replacement did not return a confirmed result",
                );
                throw cause;
            }
        });
}
