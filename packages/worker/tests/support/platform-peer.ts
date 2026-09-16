import { createServer } from "node:http";
import * as v from "valibot";
import { AUTH_TIME } from "./identity-provider.ts";

// Stateful HTTP peer for identity scenarios; live Platform credentials are not
// suitable for deterministic tests. Projects and Bots are retained by this peer.
export async function platformPeer({
    pairingLifetimeMilliseconds = 300000,
    redirectPlacement = false,
    activeBots = false,
    settingsAvailable = true,
}: {
    readonly pairingLifetimeMilliseconds?: number;
    readonly redirectPlacement?: boolean;
    readonly activeBots?: boolean;
    readonly settingsAvailable?: boolean;
} = {}) {
    const projects = new Map<string, object>();
    const bots = new Map<string, { readonly botId: string; readonly projectId: string }>();
    const sessions = new Map<string, object>();
    const conversations = new Map<
        string,
        {
            readonly projectId: string;
            readonly botId: string;
            readonly conversationId: string;
            readonly sessionId: string;
            readonly clientReference: string;
            readonly idempotencyKey: string;
            readonly bindingId: string;
            readonly bindingRevision: number;
            readonly behaviorRevisionId: string;
            readonly title: string;
            readonly lifecycle: string;
            readonly createdAt: string;
        }
    >();
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
        const placementPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/(prj_([aw])0[12]_[A-Za-z0-9_-]{24})\/storage-placement(?:\?resolved)?$/u,
        );
        if (request.method === "GET" && placementPath !== null && placementPath !== undefined) {
            if (redirectPlacement && !request.url?.endsWith("?resolved")) {
                response.writeHead(302, { location: `${request.url}?resolved` }).end();
                return;
            }
            const region = placementPath[2] === "a" ? "apac" : "wnam";
            response.writeHead(200).end(
                JSON.stringify({
                    location: region,
                }),
            );
            return;
        }
        if (request.headers.authorization !== `Bearer ${credential}`) {
            response.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
            return;
        }
        let body = "";
        for await (const chunk of request) {
            body += chunk;
        }
        const timestamp = AUTH_TIME.toISOString();
        const sessionPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/sessions(?:\/([^/?]+)(?:\/(prepare))?)?(?:\?.*)?$/u,
        );
        if (sessionPath !== undefined && sessionPath !== null) {
            const projectId = v.parse(v.string(), sessionPath[1]);
            const sessionId = sessionPath[2];
            if (sessionId === undefined && request.method === "POST") {
                const input = v.parse(
                    v.object({
                        sessionId: v.string(),
                        agentId: v.string(),
                        runtimeId: v.string(),
                        bindingId: v.string(),
                        directoryId: v.string(),
                        title: v.string(),
                        policy: v.unknown(),
                    }),
                    JSON.parse(body),
                );
                const session = {
                    ...input,
                    projectId,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    createdBy: "owner",
                    hasNativeHistory: false,
                    lastCommittedSeq: "0",
                    lifecycle: { kind: "ready" },
                    defaultBinding: {
                        agentRef: input.agentId,
                        bindingId: input.bindingId,
                        configRevision: 1,
                        createdAt: timestamp,
                        runtimeId: input.runtimeId,
                        sessionId: input.sessionId,
                        workspaceRef: input.directoryId,
                    },
                };
                sessions.set(`${projectId}:${input.sessionId}`, session);
                response.writeHead(201).end(JSON.stringify(session));
                return;
            }
            if (sessionId === undefined && request.method === "GET") {
                response.writeHead(200).end(
                    JSON.stringify({
                        sessions: [...sessions.entries()]
                            .filter(([key]) => key.startsWith(`${projectId}:`))
                            .map(([, value]) => value),
                        nextCursor: null,
                    }),
                );
                return;
            }
            const key = `${projectId}:${sessionId}`;
            if (sessions.has(key) && request.method === "POST" && sessionPath[3] === "prepare") {
                response.setHeader(
                    "server-timing",
                    'total;dur=9.0;desc="Total Platform operation time",control-runtime;dur=7.0;desc="Wait for Runtime control response"',
                );
                response.writeHead(settingsAvailable ? 200 : 409).end(
                    JSON.stringify(
                        settingsAvailable
                            ? {
                                  kind: "session.ready",
                                  sessionId,
                                  requestId: "prepare-settings",
                                  agentId: "agent-one",
                                  agentName: "Agent One",
                                  agentVersion: "1",
                                  restored: false,
                                  directoryId: "default",
                                  directoryLabel: "Workspace",
                                  additionalDirectories: [],
                                  commands: [],
                                  capabilities: {
                                      additionalDirectories: false,
                                      audioPrompt: false,
                                      closeSession: true,
                                      deleteSession: true,
                                      embeddedContextPrompt: true,
                                      imagePrompt: false,
                                      listSessions: true,
                                      loadSession: true,
                                      promptQueueing: false,
                                      resumeSession: true,
                                      steering: false,
                                      unstableForkSession: false,
                                  },
                                  configOptions: [
                                      {
                                          id: "model",
                                          name: "Model",
                                          description: "Session model",
                                          booleanValue: false,
                                          category: "model",
                                          type: "select",
                                          currentValue: "model-one",
                                          values: [
                                              {
                                                  name: "Model One",
                                                  value: "model-one",
                                                  description: "",
                                                  groupId: "",
                                                  groupName: "",
                                              },
                                              {
                                                  name: "Model Two",
                                                  value: "model-two",
                                                  description: "",
                                                  groupId: "",
                                                  groupName: "",
                                              },
                                          ],
                                      },
                                  ],
                              }
                            : { error: { code: "agent_unavailable", message: "The settings agent is unavailable" } },
                    ),
                );
                return;
            }
            if (request.method === "DELETE" && sessions.delete(key)) {
                response.writeHead(200).end(JSON.stringify({ kind: "deleted", completedAt: timestamp }));
                return;
            }
        }
        const conversationPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/conversations(?:\/([^/]+))?$/u,
        );
        if (conversationPath !== undefined && conversationPath !== null) {
            const projectId = v.parse(v.string(), conversationPath[1]);
            if (request.method === "POST" && conversationPath[2] === undefined) {
                const input = v.parse(
                    v.strictObject({
                        botId: v.string(),
                        clientReference: v.string(),
                        idempotencyKey: v.string(),
                        title: v.string(),
                        configuration: v.strictObject({
                            additionalDirectoryIds: v.array(v.string()),
                            booleanValue: v.boolean(),
                            configId: v.string(),
                            value: v.string(),
                            valueType: v.string(),
                        }),
                    }),
                    JSON.parse(body),
                );
                if (bots.get(input.botId)?.projectId !== projectId) {
                    response.writeHead(404).end();
                    return;
                }
                const key = `${projectId}:${input.botId}:${input.idempotencyKey}`;
                let conversation = conversations.get(key);
                if (conversation === undefined) {
                    const sessionId = `session-${conversations.size + 1}`;
                    conversation = {
                        projectId,
                        botId: input.botId,
                        clientReference: input.clientReference,
                        idempotencyKey: input.idempotencyKey,
                        conversationId: `conversation-${conversations.size + 1}`,
                        sessionId,
                        bindingId: "binding-1",
                        bindingRevision: 1,
                        behaviorRevisionId: "behavior-1",
                        title: input.title,
                        lifecycle: "active",
                        createdAt: timestamp,
                    };
                    conversations.set(key, conversation);
                    sessions.set(`${projectId}:${sessionId}`, {
                        sessionId,
                        agentId: "agent-one",
                        runtimeId: "runtime-1",
                        bindingId: "binding-1",
                        directoryId: "default",
                        title: input.title,
                        projectId,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                        createdBy: "owner",
                        hasNativeHistory: false,
                        lastCommittedSeq: "0",
                        lifecycle: { kind: "ready" },
                        defaultBinding: {
                            agentRef: "agent-one",
                            bindingId: "binding-1",
                            configRevision: 1,
                            createdAt: timestamp,
                            runtimeId: "runtime-1",
                            sessionId,
                            workspaceRef: "default",
                        },
                    });
                }
                response
                    .writeHead(201, {
                        "server-timing":
                            'total;dur=12.0;desc="Total Platform operation time",create-provision;dur=3.0;desc="Provision conversation Session"',
                    })
                    .end(JSON.stringify(conversation));
                return;
            }
            const conversation = [...conversations.values()].find(
                (item) => item.projectId === projectId && item.conversationId === conversationPath[2],
            );
            if (request.method === "GET" && conversation !== undefined) {
                response.writeHead(200).end(JSON.stringify(conversation));
                return;
            }
        }
        const accessUrl = new URL(request.url ?? "/", "http://platform.test");
        const accessPath = accessUrl.pathname.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/conversations\/([^/]+)\/access-credentials$/u,
        );
        if (request.method === "POST" && accessPath !== undefined && accessPath !== null) {
            const conversation = [...conversations.values()].find(
                (item) => item.projectId === accessPath[1] && item.conversationId === accessPath[2],
            );
            if (conversation !== undefined) {
                const input = v.parse(
                    v.object({ actorRef: v.string(), expiresInSeconds: v.number(), permissions: v.array(v.string()) }),
                    JSON.parse(body),
                );
                response.writeHead(201).end(
                    JSON.stringify({
                        actorRef: input.actorRef,
                        appId: "cloud-app",
                        tenantId: "tenant-test",
                        projectId: conversation.projectId,
                        conversationId: conversation.conversationId,
                        sessionId: conversation.sessionId,
                        permissions: input.permissions,
                        credentialId: "credential-1",
                        credential: `mconv_${"a".repeat(22)}_${"b".repeat(43)}`,
                        issuedAt: timestamp,
                        expiresAt: new Date(AUTH_TIME.getTime() + input.expiresInSeconds * 1000).toISOString(),
                    }),
                );
                return;
            }
        }
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
                    projectId: `prj_${input.locationHint === "apac" ? "a01" : "w01"}_${String(projects.size + 1).padStart(24, "0")}`,
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
                lifecycle: activeBots ? "active" : "draft",
                ...(activeBots ? { activeBindingId: "binding-1", activeBehaviorRevisionId: "behavior-1" } : {}),
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
                response.writeHead(200).end(
                    JSON.stringify(
                        botPath[3] === undefined
                            ? bot
                            : {
                                  executionBindings: activeBots
                                      ? [
                                            {
                                                agentConfigRevision: 1,
                                                agentRef: "agent-one",
                                                allowedDeliveryTargetIds: [],
                                                behaviorRevisionId: "behavior-1",
                                                bindingId: "binding-1",
                                                bindingRevision: 1,
                                                botId: bot.botId,
                                                completionPolicy: { kind: "none" },
                                                createdAt: timestamp,
                                                approvedAt: timestamp,
                                                lifecycle: "approved",
                                                runtimeId: "runtime-1",
                                                workspaceRef: "default",
                                            },
                                        ]
                                      : [],
                              },
                    ),
                );
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
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
