import { Hono } from "hono";
import { json } from "../../../../http/json.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createBotManagementRoutes() {
    return new Hono<ManagementHttpEnvironment>().get(
        "/computer/pairing-state",
        authenticatedSession,
        async (context) => {
            using deadline = new RequestDeadline(context.req.raw.signal, 45000);
            const signal = deadline.signal;
            return json(
                await context.var.application.services.management.readComputer(
                    context.get("session").computerId,
                    signal,
                ),
            );
        },
    );
}
