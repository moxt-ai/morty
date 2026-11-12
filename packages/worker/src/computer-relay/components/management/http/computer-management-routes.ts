import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { relayIdentifier } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import { relayBindings } from "../../../../contracts/relay-bindings.ts";
import { bodyParser } from "../../../../http/body-parser.ts";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { ComputerRelayGateway } from "../../../gateway/computer-relay.ts";
import { authenticatedSession, localSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

const pairingInput = v.strictObject({ idempotencyKey: relayIdentifier });

export function createComputerManagementRoutes() {
    const noStore: MiddlewareHandler<ManagementHttpEnvironment> = async (context, next) => {
        context.header("Cache-Control", "no-store");
        await next();
    };
    const sizeLimit = bodyLimit({
        maxSize: 4096,
        onError: () => {
            throw new ManagementError("INVALID_REQUEST", "The request is too large.", 413);
        },
    });
    return new Hono<ManagementHttpEnvironment>()
        .get("/computer/pairing-state", authenticatedSession, async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            return json(
                await context.var.application.services.management.readComputer(
                    context.get("session").computerId,
                    deadline.signal,
                ),
            );
        })
        .get("/computer", sizeLimit, authenticatedSession, async (context) => {
            const session = context.get("session");
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            return json({
                computer: await context.var.application.services.management.findComputer(
                    session.computerId,
                    deadline.signal,
                ),
            });
        })
        .post("/computer/replacement", async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            const signal = deadline.signal;
            const { authentication, management } = context.var.application.services;
            const local = await authentication.authorize(context.get("bearerToken"), "replaceComputer", signal);
            switch (local.kind) {
                case "unauthenticated":
                case "revoked":
                    throw new ManagementError("UNAUTHENTICATED", "Sign in to continue.", 401);
                case "forbidden":
                    throw new ManagementError(
                        "LOCAL_IDENTITY_REQUIRED",
                        "Use the identity saved on the computer to replace it.",
                        403,
                    );
                case "authorized":
                    break;
            }
            // This optional correlation ID is untrusted diagnostics, never authorization.
            const setupRunId = v.safeParse(v.pipe(v.string(), v.uuid()), context.req.header("x-morty-setup-run-id"));
            const audit = {
                event: "computer_replacement",
                previousComputerId: context.var.application.identity.computerId,
                setupRunId: setupRunId.success ? setupRunId.output : null,
            };
            context.var.application.logger.info({ ...audit, stage: "requested" }, "Computer replacement requested");
            try {
                const successor = await management.replaceComputer(context.var.application.identity.computerId, signal);
                // Repeating the same saved local identity reuses its successor credential, even if bootstrap
                // committed only part of its data. An explicitly revoked successor credential is never reissued.
                const response = await new ComputerRelayGateway(
                    relayBindings(context.var.application.config.bindings),
                    successor.computerId,
                ).bootstrap(
                    new Request("https://computer.internal/__computer/bootstrap", {
                        body: JSON.stringify({
                            computer: successor,
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
                            computerId: successor.computerId,
                            stage: "bootstrap_failed",
                            status: response.status,
                        },
                        "Computer replacement did not reach access revocation",
                    );
                    return response;
                }
                // Keep the local identity until setup has saved the successor, so a lost reply can be retried.
                const revoked = await authentication.revokeOtherAccess(local.token, signal);
                if (revoked.kind !== "revoked") {
                    throw new ManagementError("UNAUTHENTICATED", "Local identity is no longer available.", 401);
                }
                context.var.application.logger.info(
                    { ...audit, computerId: successor.computerId, stage: "access_revoked" },
                    "Earlier shared access revoked by Computer replacement",
                );
                return response;
            } catch (cause) {
                // Do not log request bodies, credentials, or arbitrary remote error messages. A failed response
                // cannot prove whether a request already changed access, so leave the outcome unconfirmed.
                context.var.application.logger.warn(
                    { ...audit, stage: "outcome_unconfirmed" },
                    "Computer replacement did not return a confirmed result",
                );
                throw cause;
            }
        })
        .post(
            "/pairing",
            noStore,
            sizeLimit,
            localSession("pairComputer"),
            bodyParser<ManagementHttpEnvironment, typeof pairingInput>(pairingInput),
            async (context) => {
                const session = context.get("session");
                using deadline = new RequestDeadline(context.req.raw.signal, 15000);
                const input = context.req.valid("json");
                const pairing = await context.var.application.services.management.createComputerPairing(
                    session.computerId,
                    input.idempotencyKey,
                    deadline.signal,
                );
                context.header("Cache-Control", "no-store");
                return json(pairing, 201);
            },
        )
        .get("/pairing", noStore, authenticatedSession, async (context) => {
            const session = context.get("session");
            using deadline = new RequestDeadline(context.req.raw.signal, 15000);
            return json(
                await context.var.application.services.management.readComputerPairing(
                    session.computerId,
                    deadline.signal,
                ),
            );
        });
}
