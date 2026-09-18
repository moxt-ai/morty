import { createServer } from "node:http";
import * as v from "valibot";
import { AUTH_TIME } from "./clerk.ts";

function readySession(sessionId: string, currentValue = "model-one") {
    return {
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
                id: "permission_mode",
                name: "Permissions",
                description: "Session permissions",
                booleanValue: false,
                category: "_mobius_permission",
                type: "select",
                currentValue: "workspace-write",
                values: [
                    { name: "Read only", value: "read-only", description: "", groupId: "", groupName: "" },
                    { name: "Workspace write", value: "workspace-write", description: "", groupId: "", groupName: "" },
                ],
            },
            {
                id: "model",
                name: "Model",
                description: "Session model",
                booleanValue: false,
                category: "model",
                type: "select",
                currentValue,
                values: [
                    { name: "Model One", value: "model-one", description: "", groupId: "", groupName: "" },
                    { name: "Model Two", value: "model-two", description: "", groupId: "", groupName: "" },
                ],
            },
            {
                id: "reasoning_effort",
                name: "Reasoning effort",
                description: "Session reasoning effort",
                booleanValue: false,
                category: "thought_level",
                type: "select",
                currentValue: "high",
                values: [{ name: "High", value: "high", description: "", groupId: "", groupName: "" }],
            },
        ],
    };
}

// Stateful HTTP peer for identity scenarios; live Platform credentials are not
// suitable for deterministic tests. Projects and Sessions are retained by this peer.
export async function platformPeer({
    pairingLifetimeMilliseconds = 300000,
    redirectPlacement = false,
    agentsOnline = false,
    settingsAvailable = true,
}: {
    readonly pairingLifetimeMilliseconds?: number;
    readonly redirectPlacement?: boolean;
    readonly agentsOnline?: boolean;
    readonly settingsAvailable?: boolean;
} = {}) {
    const projects = new Map<string, object>();
    const sessions = new Map<string, object>();
    const submittedTurns: unknown[] = [];
    const configuredSettings: unknown[] = [];
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
            /^\/mobius\/api\/dashboard\/v1\/projects\/(prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24})\/storage-placement(?:\?resolved)?$/u,
        );
        if (request.method === "GET" && placementPath !== null && placementPath !== undefined) {
            if (redirectPlacement && !request.url?.endsWith("?resolved")) {
                response.writeHead(302, { location: `${request.url}?resolved` }).end();
                return;
            }
            const region = ["ap", "an", "as", "oc"].includes(placementPath[2] ?? "") ? "apac" : "wnam";
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
        const turnPath = request.url?.match(/^\/mobius\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/turns$/u);
        if (request.method === "POST" && turnPath !== undefined && turnPath !== null) {
            const projectId = v.parse(v.string(), turnPath[1]);
            const sessionId = v.parse(v.string(), turnPath[2]);
            if (sessions.has(`${projectId}:${sessionId}`)) {
                const input = v.parse(
                    v.object({
                        content: v.string(),
                        idempotencyKey: v.string(),
                        images: v.array(v.unknown()),
                        resources: v.array(v.unknown()),
                    }),
                    JSON.parse(body),
                );
                submittedTurns.push(input);
                response.writeHead(202).end(
                    JSON.stringify({
                        acceptedAt: timestamp,
                        bindingId: "binding-1",
                        idempotencyKey: input.idempotencyKey,
                        request: { kind: "prompt", content: input.content },
                        sessionId,
                        state: { kind: "queued" },
                        turnId: `turn-${submittedTurns.length}`,
                    }),
                );
                return;
            }
        }
        const sessionPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/sessions(?:\/([^/?]+)(?:\/(prepare|configuration|access-credentials))?)?(?:\?.*)?$/u,
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
            if (sessions.has(key) && request.method === "GET" && sessionPath[3] === undefined) {
                response.writeHead(200).end(JSON.stringify(sessions.get(key)));
                return;
            }
            if (sessions.has(key) && request.method === "POST" && sessionPath[3] === "prepare") {
                response.setHeader(
                    "server-timing",
                    'total;dur=9.0;desc="Total Platform operation time",control-runtime;dur=7.0;desc="Wait for Runtime control response"',
                );
                response.writeHead(settingsAvailable ? 200 : 409).end(
                    JSON.stringify(
                        settingsAvailable
                            ? readySession(v.parse(v.string(), sessionId))
                            : {
                                  error: {
                                      code: "agent_unavailable",
                                      message: "The settings agent is unavailable",
                                  },
                              },
                    ),
                );
                return;
            }
            if (sessions.has(key) && request.method === "POST" && sessionPath[3] === "configuration") {
                configuredSettings.push(JSON.parse(body));
                response.writeHead(200).end(
                    JSON.stringify({
                        kind: "session.config.updated",
                        sessionId,
                        requestId: "configure-1",
                        configOptions: readySession(v.parse(v.string(), sessionId)).configOptions,
                    }),
                );
                return;
            }
            if (sessions.has(key) && request.method === "POST" && sessionPath[3] === "access-credentials") {
                const input = v.parse(v.object({ expiresInSeconds: v.number() }), JSON.parse(body));
                response.writeHead(201).end(
                    JSON.stringify({
                        credential: `msession_${"a".repeat(22)}_${"b".repeat(43)}`,
                        credentialId: "credential-1",
                        projectId,
                        sessionId,
                        expiresAt: new Date(AUTH_TIME.getTime() + input.expiresInSeconds * 1000).toISOString(),
                    }),
                );
                return;
            }
            if (request.method === "DELETE" && sessions.delete(key)) {
                response.writeHead(200).end(JSON.stringify({ kind: "deleted", completedAt: timestamp }));
                return;
            }
            response.writeHead(404).end(JSON.stringify({ error: { code: "session_not_found", message: "Not found" } }));
            return;
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
        if (request.method === "POST" && request.url === "/mobius/api/dashboard/v1/apps/cloud-app/projects") {
            const input = v.parse(
                v.object({
                    idempotencyKey: v.string(),
                    clientReference: v.string(),
                    displayName: v.string(),
                    locationHint: v.picklist([
                        "wnam",
                        "enam",
                        "sam",
                        "weur",
                        "eeur",
                        "apac",
                        "apac-ne",
                        "apac-se",
                        "oc",
                        "afr",
                        "me",
                    ]),
                }),
                JSON.parse(body),
            );
            let project = projects.get(input.idempotencyKey);
            if (project === undefined) {
                project = {
                    projectId: `prj_${{ wnam: "wn", enam: "en", sam: "sa", weur: "we", eeur: "ee", apac: "ap", "apac-ne": "an", "apac-se": "as", oc: "oc", afr: "af", me: "me" }[input.locationHint]}_01_${String(projects.size + 1).padStart(24, "0")}`,
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
        const agentSettingsPath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/runtimes\/([^/]+)\/agent-settings$/u,
        );
        if (request.method === "POST" && agentSettingsPath !== undefined && agentSettingsPath !== null) {
            const input = v.parse(
                v.strictObject({
                    additionalDirectoryIds: v.array(v.string()),
                    agentId: v.string(),
                    directoryId: v.string(),
                }),
                JSON.parse(body),
            );
            response.writeHead(settingsAvailable ? 200 : 409).end(
                JSON.stringify(
                    settingsAvailable
                        ? {
                              kind: "agent.settings.discovered",
                              requestId: "discover-settings",
                              agentId: input.agentId,
                              agentName: "Agent One",
                              agentVersion: "1",
                              directoryId: input.directoryId,
                              configOptions: readySession("settings").configOptions,
                          }
                        : { error: { code: "agent_unavailable", message: "The settings agent is unavailable" } },
                ),
            );
            return;
        }
        const workspacePath = request.url?.match(
            /^\/mobius\/api\/v1\/projects\/([^/]+)\/runtimes\/([^/]+)\/workspace$/u,
        );
        if (request.method === "POST" && workspacePath !== undefined && workspacePath !== null) {
            const input = v.parse(v.strictObject({ directoryId: v.string() }), JSON.parse(body));
            const selectedDirectoryId = "path-L2hvbWUvYS9tb2JpdXMudDMvc2VsZWN0ZWQtcHJvamVjdA";
            const directoryLabel =
                input.directoryId === selectedDirectoryId ? "/home/a/mobius.t3/selected-project" : "/home/a/mobius.t3";
            response.writeHead(200).end(
                JSON.stringify({
                    kind: "workspace.entries",
                    requestId: "workspace-request",
                    bindingId: "binding-1",
                    directoryId: input.directoryId,
                    directoryLabel,
                    entries:
                        input.directoryId === "default"
                            ? [{ directoryId: selectedDirectoryId, name: "selected-project" }]
                            : [],
                    parentDirectoryId: "path-L2hvbWUvYQ",
                }),
            );
            return;
        }
        const runtimePath = request.url?.match(/^\/mobius\/api\/v1\/projects\/([^/]+)\/runtimes$/u);
        if (
            request.method === "GET" &&
            runtimePath !== undefined &&
            runtimePath !== null &&
            [...projects.values()].some(
                (project) => v.parse(v.object({ projectId: v.string() }), project).projectId === runtimePath[1],
            )
        ) {
            response.writeHead(200).end(
                JSON.stringify({
                    runtimes: agentsOnline
                        ? [
                              {
                                  runtimeId: "runtime-1",
                                  projectId: runtimePath[1],
                                  channelId: "channel-1",
                                  machineName: "Local machine",
                                  workspaceName: "Workspace",
                                  online: true,
                                  agents: [
                                      {
                                          id: "agent-one",
                                          label: "Agent One",
                                          agentPath: "/agents/agent-one",
                                          agentVersion: "1",
                                          capabilities: readySession("descriptor").capabilities,
                                      },
                                  ],
                                  installableAgents: [],
                              },
                          ]
                        : [],
                }),
            );
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
        configuredSettings: () => [...configuredSettings],
        submittedTurns: () => [...submittedTurns],
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
