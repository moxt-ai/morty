import { createServer } from "node:http";
import * as v from "valibot";
import { AUTH_TIME } from "./identity-provider.ts";

// Stateful HTTP peer for identity scenarios; live Platform credentials are not
// suitable for deterministic tests. Projects and Bots are retained by this peer.
export async function platformPeer() {
    const projects = new Map<string, object>();
    const bots = new Map<string, object>();
    const credential = `mapp_${"a".repeat(22)}_${"b".repeat(43)}`;
    const server = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${credential}`) {
            response.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
            return;
        }
        let body = "";
        for await (const chunk of request) {
            body += chunk;
        }
        const timestamp = AUTH_TIME.toISOString();
        if (request.method === "POST" && request.url === "/mobius/api/v1/apps/cloud-app/projects") {
            const input = v.parse(
                v.object({
                    idempotencyKey: v.string(),
                    clientReference: v.string(),
                    displayName: v.string(),
                    locationHint: v.literal("apac"),
                }),
                JSON.parse(body),
            );
            let project = projects.get(input.idempotencyKey);
            if (project === undefined) {
                project = {
                    projectId: `project-${projects.size + 1}`,
                    appId: "cloud-app",
                    tenantId: "tenant-test",
                    clientReference: input.clientReference,
                    displayName: input.displayName,
                    lifecycle: "active",
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    deletedAt: "",
                    suspendedAt: "",
                };
                projects.set(input.idempotencyKey, project);
            }
            response.writeHead(201).end(JSON.stringify(project));
            return;
        }
        const match = request.url?.match(/^\/mobius\/api\/v1\/projects\/([^/]+)\/bots$/u);
        if (request.method === "POST" && match !== null && match !== undefined) {
            const input = v.parse(
                v.object({ displayName: v.string(), description: v.string(), avatarRef: v.string() }),
                JSON.parse(body),
            );
            const bot = {
                ...input,
                botId: `bot-${bots.size + 1}`,
                projectId: match[1],
                createdAt: timestamp,
                updatedAt: timestamp,
                currentProfileRevisionId: `profile-${bots.size + 1}`,
                lifecycle: "draft",
                lifecycleRevision: 1,
                profileRevision: 1,
            };
            bots.set(bot.botId, bot);
            response.writeHead(201).end(JSON.stringify(bot));
            return;
        }
        response.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "localhost", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Platform peer address");
    }
    return {
        bindings: {
            MOBIUS_APP_ID: "cloud-app",
            MOBIUS_APP_SECRET: credential,
            MOBIUS_BASE_URL: `http://localhost:${address.port}`,
            MOBIUS_PROJECT_LOCATION_HINT: "apac",
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
