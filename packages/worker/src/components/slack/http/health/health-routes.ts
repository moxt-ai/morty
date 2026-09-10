import { Hono } from "hono";

interface HealthResponse {
    readonly service: "app-slack";
    readonly status: "ok";
}

export function createHealthRoutes() {
    return new Hono().get("/health", (context) =>
        context.json<HealthResponse>({
            service: "app-slack",
            status: "ok",
        }),
    );
}
