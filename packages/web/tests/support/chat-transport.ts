import type { ApiTransport } from "../../src/services/api/api-transport-context.tsx";

const projectId = "project-one";
const botId = "bot-one";

export class ChatTransport implements ApiTransport {
    #agentOnline = false;
    readonly #workspaceChanges = new Set<() => void>();

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
                selected: {
                    runtimeId: "runtime-one",
                    agentRef: "opencode",
                    workspaceRef: "default",
                    agentConfigRevision: 1,
                },
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
                bindingId: "binding-one",
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
                                {
                                    description: "",
                                    groupId: "",
                                    groupName: "",
                                    name: "Model Two",
                                    value: "model-two",
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
                parentDirectoryId: "",
                requestId: "workspace-request",
            });
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
