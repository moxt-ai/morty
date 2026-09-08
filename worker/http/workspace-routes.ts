import * as v from "valibot";
import { requestRegion } from "../gateway/workspace-creator.ts";
import { json } from "../infra/http.ts";
import { WorkspaceCreationError } from "../service/workspace-creator.ts";
import type { CloudHttpEnvironment } from "./cloud-http-environment.ts";

export function createWorkspaceRoutes() {
    return new Hono<CloudHttpEnvironment>().all("/workspaces", async (context) => {
        const request = context.req.raw;
        if (request.method !== "POST") {
            return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405, {
                Allow: "POST",
            });
        }
        const token = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
        const authentication = await context.env.services.authentication.session(token, request.signal);
        if (authentication.kind === "unauthenticated") {
            return json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401);
        }
        if (authentication.kind === "unavailable") {
            return json(
                {
                    error: {
                        code: "WORKSPACES_UNAVAILABLE",
                        message: "Workspace creation is temporarily unavailable.",
                    },
                },
                503,
            );
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            request.signal.throwIfAborted();
            return json({ error: { code: "INVALID_INPUT", message: "Enter a valid workspace name." } }, 400);
        }
        const input = v.safeParse(
            v.strictObject({ name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)) }),
            body,
        );
        if (!input.success) {
            return json({ error: { code: "INVALID_INPUT", message: "Enter a valid workspace name." } }, 400);
        }
        try {
            return json(
                await context.env.gateways.workspaceCreator.create(
                    { userId: authentication.session.userId, name: input.output.name, region: requestRegion(request) },
                    request.signal,
                ),
                201,
            );
        } catch (cause) {
            request.signal.throwIfAborted();
            if (!(cause instanceof WorkspaceCreationError)) {
                throw cause;
            }
            switch (cause.code) {
                case "INVALID_INPUT":
                    return json({ error: { code: cause.code, message: "Enter a valid workspace name." } }, 400);
                case "WORKSPACES_TIMEOUT":
                    return json({ error: { code: cause.code, message: "Workspace creation timed out." } }, 504);
                case "WORKSPACES_UNAVAILABLE":
                    return json(
                        { error: { code: cause.code, message: "Workspace creation is temporarily unavailable." } },
                        503,
                    );
            }
        }
    });
}

import { Hono } from "hono";
