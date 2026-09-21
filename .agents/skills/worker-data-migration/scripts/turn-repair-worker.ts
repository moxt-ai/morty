interface Env {
    readonly NON_CLOUD_RETENTION_SESSION_RELAY: DurableObjectNamespace;
    readonly HELPER_TOKEN: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function identifier(value: string | null): string | null {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function sessionEndpoint(projectId: string, runtimeId: string, sessionId: string, operation: string): URL {
    const endpoint = new URL("https://session.internal/internal/projects/x/runtimes/y/sessions/z/op");
    endpoint.pathname = `/internal/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
        runtimeId,
    )}/sessions/${encodeURIComponent(sessionId)}/${operation}`;
    return endpoint;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.headers.get("x-helper-token") !== env.HELPER_TOKEN) {
            return json({ error: "unauthorized" }, 401);
        }
        const url = new URL(request.url);

        if (url.pathname === "/repair-turn" && request.method === "POST") {
            const value: unknown = await request.json().catch(() => null);
            if (typeof value !== "object" || value === null) {
                return json({ error: "invalid_request" }, 400);
            }
            const body = Object.fromEntries(Object.entries(value));
            const projectId = identifier(typeof body["projectId"] === "string" ? body["projectId"] : null);
            const runtimeId = identifier(typeof body["runtimeId"] === "string" ? body["runtimeId"] : null);
            const sessionId = identifier(typeof body["sessionId"] === "string" ? body["sessionId"] : null);
            const commandId = identifier(typeof body["commandId"] === "string" ? body["commandId"] : null);
            const repairToken = typeof body["repairToken"] === "string" ? body["repairToken"] : "";
            if (
                Object.keys(body).sort().join(",") !== "commandId,projectId,repairToken,runtimeId,sessionId" ||
                projectId === null ||
                runtimeId === null ||
                sessionId === null ||
                commandId === null ||
                repairToken.length === 0
            ) {
                return json({ error: "invalid_request" }, 400);
            }
            const session = env.NON_CLOUD_RETENTION_SESSION_RELAY.getByName(`platform:${projectId}:${sessionId}`);
            const response = await session.fetch(
                sessionEndpoint(projectId, runtimeId, sessionId, "repair-scrubbed-turn"),
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-repair-token": repairToken },
                    body: JSON.stringify({ commandId }),
                },
            );
            const result: unknown = await response.json().catch(() => null);
            return json({ status: response.status, result }, response.ok ? 200 : 502);
        }

        if (url.pathname === "/repair-all-turns" && request.method === "POST") {
            const value: unknown = await request.json().catch(() => null);
            if (typeof value !== "object" || value === null) {
                return json({ error: "invalid_request" }, 400);
            }
            const body = Object.fromEntries(Object.entries(value));
            const projectId = identifier(typeof body["projectId"] === "string" ? body["projectId"] : null);
            const runtimeId = identifier(typeof body["runtimeId"] === "string" ? body["runtimeId"] : null);
            const sessionId = identifier(typeof body["sessionId"] === "string" ? body["sessionId"] : null);
            const repairToken = typeof body["repairToken"] === "string" ? body["repairToken"] : "";
            if (
                Object.keys(body).sort().join(",") !== "projectId,repairToken,runtimeId,sessionId" ||
                projectId === null ||
                runtimeId === null ||
                sessionId === null ||
                repairToken.length === 0
            ) {
                return json({ error: "invalid_request" }, 400);
            }
            const session = env.NON_CLOUD_RETENTION_SESSION_RELAY.getByName(`platform:${projectId}:${sessionId}`);
            const response = await session.fetch(
                sessionEndpoint(projectId, runtimeId, sessionId, "repair-all-scrubbed-turns"),
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-repair-token": repairToken },
                    body: JSON.stringify({}),
                },
            );
            const result: unknown = await response.json().catch(() => null);
            return json({ status: response.status, result }, response.ok ? 200 : 502);
        }

        if (url.pathname === "/read-turn" && request.method === "POST") {
            const value: unknown = await request.json().catch(() => null);
            if (typeof value !== "object" || value === null) {
                return json({ error: "invalid_request" }, 400);
            }
            const body = Object.fromEntries(Object.entries(value));
            const projectId = identifier(typeof body["projectId"] === "string" ? body["projectId"] : null);
            const runtimeId = identifier(typeof body["runtimeId"] === "string" ? body["runtimeId"] : null);
            const sessionId = identifier(typeof body["sessionId"] === "string" ? body["sessionId"] : null);
            const turnId = identifier(typeof body["turnId"] === "string" ? body["turnId"] : null);
            if (
                Object.keys(body).sort().join(",") !== "projectId,runtimeId,sessionId,turnId" ||
                projectId === null ||
                runtimeId === null ||
                sessionId === null ||
                turnId === null
            ) {
                return json({ error: "invalid_request" }, 400);
            }
            const session = env.NON_CLOUD_RETENTION_SESSION_RELAY.getByName(`platform:${projectId}:${sessionId}`);
            const response = await session.fetch(sessionEndpoint(projectId, runtimeId, sessionId, "turn"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ scope: { projectId }, sessionId, turnId }),
            });
            const result: unknown = await response.json().catch(() => null);
            return json({ status: response.status, result }, response.ok ? 200 : 502);
        }

        return json({ error: "not found" }, 404);
    },
};
