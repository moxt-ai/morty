import { createServer } from "node:http";
import * as v from "valibot";
import { AUTH_TIME } from "./identity-provider.ts";

// Stateful HTTP peer for identity scenarios; live Platform credentials are not
// suitable for deterministic tests. Projects and Bots are retained by this peer.
export async function platformPeer({
    pairingLifetimeMilliseconds = 300000,
}: {
    readonly pairingLifetimeMilliseconds?: number;
} = {}) {
    const projects = new Map<string, object>();
    const bots = new Map<string, { readonly botId: string; readonly projectId: string }>();
    const pairings = new Map<
        string,
        {
            readonly pairingId: string;
            readonly projectId: string;
            readonly runtimeId: string;
            readonly channelId: string;
            readonly pairingCode: string;
            readonly pollToken: string;
            readonly expiresAt: string;
        }
    >();
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
        const pairingPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/runtime-pairings(?:\/([^/]+))?$/u,
        );
        if (pairingPath !== undefined && pairingPath !== null) {
            const projectId = v.parse(v.string(), pairingPath[1]);
            if (request.method === "POST" && pairingPath[2] === undefined) {
                const input = v.parse(v.object({ idempotencyKey: v.string() }), JSON.parse(body));
                const key = `${projectId}:${input.idempotencyKey}`;
                let pairing = pairings.get(key);
                if (pairing === undefined) {
                    pairing = {
                        pairingId: `pair-${pairings.size + 1}`,
                        projectId,
                        runtimeId: `runtime-${pairings.size + 1}`,
                        channelId: `channel-${pairings.size + 1}`,
                        pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                        pollToken: "p".repeat(43),
                        expiresAt: new Date(AUTH_TIME.getTime() + pairingLifetimeMilliseconds).toISOString(),
                    };
                    pairings.set(key, pairing);
                }
                response.writeHead(201).end(JSON.stringify(pairing));
                return;
            }
            const pairing = [...pairings.values()].find(
                (value) => value.projectId === projectId && value.pairingId === pairingPath[2],
            );
            if (pairing !== undefined) {
                response
                    .writeHead(200)
                    .end(
                        JSON.stringify(
                            Date.parse(pairing.expiresAt) <= Date.now()
                                ? { status: "expired" }
                                : { status: "pending", expiresAt: pairing.expiresAt },
                        ),
                    );
                return;
            }
        }
        if (request.method === "POST" && request.url === "/mobius/api/v1/apps/cloud-app/projects") {
            const input = v.parse(
                v.object({
                    idempotencyKey: v.string(),
                    clientReference: v.string(),
                    displayName: v.string(),
                    locationHint: v.picklist(["apac", "wnam"]),
                }),
                JSON.parse(body),
            );
            let project = projects.get(input.idempotencyKey);
            if (project === undefined) {
                project = {
                    projectId: `${input.locationHint}-project-${projects.size + 1}`,
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
                projectId: v.parse(v.string(), match[1]),
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
        const botPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/bots\/([^/]+)(?:\/(execution-bindings))?$/u,
        );
        if (request.method === "GET" && botPath !== undefined && botPath !== null) {
            const bot = bots.get(v.parse(v.string(), botPath[2]));
            if (bot !== undefined && bot.projectId === botPath[1]) {
                response.writeHead(200).end(JSON.stringify(botPath[3] === undefined ? bot : { executionBindings: [] }));
                return;
            }
        }
        const runtimePath = request.url?.match(/^\/mobius\/api\/v1\/projects\/([^/]+)\/runtimes$/u);
        if (
            request.method === "GET" &&
            runtimePath !== undefined &&
            runtimePath !== null &&
            [...bots.values()].some((bot) => bot.projectId === runtimePath[1])
        ) {
            response.writeHead(200).end(JSON.stringify({ runtimes: [] }));
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
