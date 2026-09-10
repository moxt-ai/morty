import { Hono } from "hono";
import { json } from "../../../infra/http.ts";
import { createAuthenticationRoutes } from "./authentication-routes.ts";
import type { CloudHttpEnvironment } from "./cloud-http-environment.ts";

export function createCloudApplication() {
    return new Hono<CloudHttpEnvironment>()
        .basePath("/mobius-cloud/api")
        .onError((error) => {
            throw error;
        })
        .notFound(() => json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404))
        .route("/", createAuthenticationRoutes());
}
