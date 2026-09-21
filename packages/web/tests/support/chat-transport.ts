import type { ApiTransport } from "../../src/services/api/api-transport-context.tsx";

const projectId = "project-one";
const botId = "bot-one";

export class ChatTransport implements ApiTransport {
    #agentOnline = false;
    readonly #forkFailure: boolean;
    readonly #workspaceChanges = new Set<() => void>();

    constructor(options: { readonly forkFailure?: boolean } = {}) {
        this.#forkFailure = options.forkFailure ?? false;
    }

    readonly open = (): void => {};
    readonly close = (): void => {};

    readonly connectAgent = (): void => {
        this.#agentOnline = true;
        for (const changed of this.#workspaceChanges) {
            changed();
        }
        this.#workspaceChanges.clear();
    };

    readonly fetch = async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === `/mobius-cloud/api/projects/${projectId}/management/bots`) {
            return Response.json({ bots: [{ botId, displayName: "Local agent" }] });
        }
        if (
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/workspace`
        ) {
            return Response.json({
                status: "active",
                runtimeId: "runtime-one",
                agents: [
                    {
                        runtimeId: "runtime-one",
                        agentRef: "opencode",
                        label: "OpenCode",
                        machineName: "Development Mac",
                        online: this.#agentOnline,
                    },
                ],
            });
        }
        if (
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/agent-settings`
        ) {
            return Response.json({
                settings: {
                    agentId: "opencode",
                    agentName: "OpenCode",
                    agentVersion: "1",
                    kind: "agent.settings.discovered",
                    modelEffort: {
                        effortSettingId: "",
                        modelSettingId: "model",
                        resolution: "unavailable",
                        unsupportedModelIds: [],
                        valuesByModel: {},
                    },
                    requestId: "settings-request",
                    settings: [
                        {
                            booleanValue: false,
                            category: "model",
                            defaultValue: "model-one",
                            description: "Session model",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "",
                                    groupId: "",
                                    groupName: "",
                                    name: "Model One",
                                    value: "model-one",
                                },
                            ],
                        },
                    ],
                    settingsRevision: "a".repeat(64),
                },
            });
        }
        if (
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/workspace/directory`
        ) {
            return Response.json({
                bindingId: "binding-one",
                directoryId: "default",
                directoryLabel: "/workspace",
                entries: [],
                kind: "workspace.entries",
                parentDirectoryId: null,
                requestId: "workspace-request",
            });
        }
        if (request.method === "POST" && path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/access`) {
            return Response.json(
                { error: { code: "PLATFORM_INVALID_RESPONSE", message: "Platform returned an unexpected Session." } },
                { status: 502 },
            );
        }
        if (
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/managed-session`
        ) {
            return Response.json(
                {
                    error: {
                        code: this.#agentOnline ? "INVALID_SESSION" : "runtime_offline",
                        message: this.#agentOnline
                            ? "The saved Session is unavailable."
                            : "The local Runtime is offline.",
                    },
                },
                { status: 409 },
            );
        }
        if (
            this.#forkFailure &&
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/native-sessions`
        ) {
            return Response.json({
                action: "list",
                capabilities: {
                    additionalDirectories: false,
                    audioPrompt: false,
                    closeSession: false,
                    deleteSession: false,
                    embeddedContextPrompt: false,
                    imagePrompt: false,
                    listSessions: true,
                    loadSession: true,
                    promptQueueing: false,
                    resumeSession: true,
                    steering: false,
                    unstableForkSession: true,
                },
                entries: [
                    {
                        additionalDirectories: [],
                        directoryId: "default",
                        directoryLabel: "/workspace",
                        entryId: "entry-one",
                        title: "Locked Codex session",
                        updatedAt: "2026-09-21T00:00:00.000Z",
                    },
                ],
                kind: "native.session.result",
                nextCursor: null,
                requestId: "native-list-request",
                sessionId: "discovery-one",
            });
        }
        if (
            this.#forkFailure &&
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/native-session/entry-one`
        ) {
            return Response.json({
                history: {
                    coveredCommandIds: [],
                    messages: [{ role: "user", text: "Original Codex request" }],
                    status: "available",
                    truncated: false,
                },
                title: "Locked Codex session",
            });
        }
        if (
            this.#forkFailure &&
            request.method === "POST" &&
            path === `/mobius-cloud/api/chat/projects/${projectId}/bots/${botId}/native-session/entry-one/fork`
        ) {
            return Response.json(
                {
                    error: {
                        code: "acp_agent_error",
                        message: "Codex cannot fork this session while its source thread is active.",
                    },
                },
                { status: 502 },
            );
        }
        if (request.method === "POST" && path === `/mobius-cloud/api/projects/${projectId}/identity/pairings`) {
            return Response.json({
                url: `${window.location.origin}/pair.md?token=mobius_pair_v2.runtime.${"a".repeat(43)}`,
                expiresAt: "2026-10-01T00:00:00.000Z",
            });
        }
        return Response.json(
            { error: { code: "UNEXPECTED_REQUEST", message: `${request.method} ${path}` } },
            { status: 500 },
        );
    };

    readonly waitForChange = async (request: Request): Promise<void> =>
        await new Promise<void>((resolve) => {
            const finish = () => {
                request.signal.removeEventListener("abort", finish);
                this.#workspaceChanges.delete(finish);
                resolve();
            };
            this.#workspaceChanges.add(finish);
            request.signal.addEventListener("abort", finish, { once: true });
        });
}

export const applicationIdentity = {
    getToken: async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return "anonymous-token";
    },
    kind: "anonymous" as const,
    projectId,
};
