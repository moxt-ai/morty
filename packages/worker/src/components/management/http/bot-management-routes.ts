import { Hono } from "hono";
import { json } from "../../../infra/http.ts";
import { RequestDeadline } from "../../../infra/request-deadline.ts";
import { authenticatedSession } from "./authenticated-session.ts";
import type { ManagementHttpEnvironment } from "./management-http-environment.ts";

export function createBotManagementRoutes() {
    return new Hono<ManagementHttpEnvironment>().get("/machine", authenticatedSession, async (context) => {
        using deadline = new RequestDeadline(context.req.raw.signal, 45000);
        const signal = deadline.signal;
        return json(await context.env.services.management.readMachine(context.get("session").userId, signal));
    });
}
