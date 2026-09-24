import {
    MobiusApiError,
    MobiusAppCredentialProvider,
    MobiusCancellationError,
    MobiusError,
    MobiusPlatformAppClient,
    MobiusTimeoutError,
} from "@moxt-ai/mobius-sdk/platform";
import {
    AGENT_DEFAULT_EXECUTION_SETTING,
    MobiusClient,
    MobiusRecordingPolicy,
    MobiusRuntimePairingRequest,
} from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import {
    PlatformProjectError,
    platformIdentifier,
    platformProjectSchema,
} from "../components/management/entity/platform-project.ts";
import type { ProjectLocationHint } from "../components/management/util/project-location.ts";
import {
    appOriginBindingSchema,
    type CloudBindings,
    platformCredentialBindingsSchema,
    platformEndpointBindingsSchema,
} from "../infra/cloud-bindings.ts";

export type ChatConversationInput =
    | {
          readonly kind: "existing";
          readonly conversationId: string;
          readonly runtimeId: string;
          readonly agentRef: string;
          readonly workspaceRef: string;
          readonly additionalDirectoryIds: readonly string[];
      }
    | {
          readonly kind: "new";
          readonly conversationKey: string;
          readonly bindingId: string;
          readonly runtimeId: string;
          readonly agentRef: string;
          readonly configurations: readonly {
              readonly booleanValue: boolean;
              readonly configId: string;
              readonly value: string;
              readonly valueType: "select" | "boolean";
          }[];
          readonly workspaceRef: string;
      }
    | {
          readonly kind: "new";
          readonly conversationKey: string;
          readonly bindingId: string;
          readonly runtimeId: string;
          readonly agentRef: string;
          readonly workspaceRef: string;
          readonly permissionMode: string;
          readonly configuration: {
              readonly additionalDirectoryIds: readonly string[];
              readonly booleanValue: boolean;
              readonly configId: string;
              readonly value: string;
              readonly valueType: "select" | "boolean";
          };
      };

export class PlatformProjectGateway {
    readonly #bindings: CloudBindings;
    constructor(bindings: CloudBindings) {
        this.#bindings = bindings;
    }

    readonly #observeMobiusResponse = ({ serverTiming }: { readonly serverTiming: string | null }): void => {
        this.#bindings.requestAccessMetrics?.recordMobiusServerTiming(serverTiming);
    };

    readonly configuration = () => {
        try {
            const bindings = v.parse(platformEndpointBindingsSchema, this.#bindings);
            const appOrigin = v.safeParse(appOriginBindingSchema, this.#bindings);
            const endpoint = new URL(bindings.MOBIUS_BASE_URL);
            if (
                (endpoint.protocol !== "https:" &&
                    !(
                        endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
                    )) ||
                endpoint.username !== "" ||
                endpoint.password !== "" ||
                endpoint.pathname !== "/" ||
                endpoint.search !== "" ||
                endpoint.hash !== "" ||
                (appOrigin.success && endpoint.origin === new URL(appOrigin.output.APP_ORIGIN).origin)
            ) {
                throw new Error("Invalid Platform endpoint");
            }
            return { origin: endpoint.origin, appId: v.parse(platformIdentifier, bindings.MOBIUS_APP_ID) };
        } catch (cause) {
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform is not configured.", 503, { cause });
        }
    };

    readonly createPairing = async (projectId: string, idempotencyKey: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const pairing = await client.runtimePairings.create(
                new MobiusRuntimePairingRequest(idempotencyKey),
                signal,
            );
            if (pairing.projectId !== projectId) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Platform returned an unexpected pairing.",
                    502,
                );
            }
            const configuration = this.configuration();
            return { ...pairing, appId: configuration.appId, relayUrl: configuration.origin };
        });

    readonly chatRuntimes = async (projectId: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const runtimes = await client.runtimes.list(signal);
            return runtimes.map((runtime) => ({
                runtimeId: runtime.runtimeId,
                machineName: runtime.machineName,
                online: runtime.online,
                agents: runtime.agents.map((agent) => ({ agentRef: agent.id, label: agent.label })),
            }));
        });

    readonly openChatRuntimeHost = async (
        projectId: string,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<WebSocket> => {
        signal.throwIfAborted();
        const endpoint = new URL(this.configuration().origin);
        endpoint.pathname = `/mobius/api/v1/projects/${encodeURIComponent(v.parse(platformIdentifier, projectId))}/runtimes/${encodeURIComponent(v.parse(platformIdentifier, runtimeId))}/host`;
        endpoint.searchParams.set("token", v.parse(platformCredentialBindingsSchema, this.#bindings).MOBIUS_APP_SECRET);
        const handshake = new AbortController();
        const abort = () => handshake.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => handshake.abort(new Error("Runtime connection timed out.")), 20_000);
        let response: Response;
        try {
            response = await fetch(endpoint, { headers: { Upgrade: "websocket" }, signal: handshake.signal });
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
        }
        if (response.status !== 101 || response.webSocket === null) {
            throw new PlatformProjectError("RUNTIME_UNAVAILABLE", "The local Runtime could not be connected.", 503);
        }
        return response.webSocket;
    };

    readonly listChatWorkspace = async (
        projectId: string,
        runtimeId: string,
        directoryId: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.listWorkspace(runtimeId, directoryId, signal),
            120000,
        );

    readonly discoverChatAgentSettings = async (
        projectId: string,
        selection: { readonly runtimeId: string; readonly agentRef: string; readonly workspaceRef: string },
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const settings = await client.runtimes.discoverAgentSettings(
                    selection.runtimeId,
                    selection.agentRef,
                    {},
                    signal,
                );
                if (settings.agentId !== selection.agentRef) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned settings for an unexpected Agent.",
                        502,
                    );
                }
                return settings;
            },
            120000,
        );

    readonly openChatSession = async (
        projectId: string,
        input: ChatConversationInput,
        title: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const sessionId = input.kind === "existing" ? input.conversationId : input.conversationKey;
                const additionalDirectoryIds =
                    input.kind === "new" && "configuration" in input
                        ? input.configuration.additionalDirectoryIds
                        : input.kind === "existing"
                          ? input.additionalDirectoryIds
                          : [];
                const ready =
                    input.kind === "new"
                        ? await client.sessions.create(
                              {
                                  additionalDirectoryIds,
                                  agentId: input.agentRef,
                                  bindingId: input.bindingId,
                                  directoryId: input.workspaceRef,
                                  policy: new MobiusRecordingPolicy("full", 30 * 24 * 60 * 60 * 1000, 1000, 6_000_000),
                                  runtimeId: input.runtimeId,
                                  sessionId,
                                  title,
                              },
                              signal,
                          )
                        : await client.sessions.load(
                              input.runtimeId,
                              sessionId,
                              {
                                  additionalDirectoryIds,
                                  agentId: input.agentRef,
                                  directoryId: input.workspaceRef,
                              },
                              signal,
                          );
                if (ready.sessionId !== sessionId) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned an unexpected Session.",
                        502,
                    );
                }
                let configOptions = ready.configOptions;
                if (input.kind === "new" && "configurations" in input) {
                    for (const selection of input.configurations) {
                        const option = configOptions.find((candidate) => candidate.id === selection.configId);
                        if (
                            option === undefined ||
                            option.type !== selection.valueType ||
                            (option.type === "select" &&
                                !option.values.some((value) => value.value === selection.value))
                        ) {
                            continue;
                        }
                        if (option.type === "boolean" && option.booleanValue === selection.booleanValue) {
                            continue;
                        }
                        if (option.type === "select" && option.currentValue === selection.value) {
                            continue;
                        }
                        configOptions = (
                            await client.sessions.updateConfiguration(
                                input.runtimeId,
                                sessionId,
                                {
                                    ...selection,
                                    agentId: input.agentRef,
                                    directoryId: input.workspaceRef,
                                    additionalDirectoryIds,
                                },
                                signal,
                            )
                        ).configOptions;
                    }
                } else if (input.kind === "new" && "configuration" in input) {
                    if (input.permissionMode !== AGENT_DEFAULT_EXECUTION_SETTING) {
                        const permission = configOptions.find((option) => option.id === "permission_mode");
                        if (
                            permission === undefined ||
                            permission.type !== "select" ||
                            !permission.values.some((value) => value.value === input.permissionMode)
                        ) {
                            throw new PlatformProjectError(
                                "AGENT_CONFIGURATION_REJECTED",
                                "The harness did not offer the selected permission mode.",
                                409,
                            );
                        }
                        if (permission.currentValue !== input.permissionMode) {
                            configOptions = (
                                await client.sessions.updateConfiguration(
                                    input.runtimeId,
                                    sessionId,
                                    {
                                        agentId: input.agentRef,
                                        directoryId: input.workspaceRef,
                                        additionalDirectoryIds,
                                        configId: permission.id,
                                        value: input.permissionMode,
                                        booleanValue: false,
                                        valueType: "select",
                                    },
                                    signal,
                                )
                            ).configOptions;
                        }
                    }
                    const option = configOptions.find((candidate) => candidate.id === input.configuration.configId);
                    if (
                        option === undefined ||
                        option.type !== input.configuration.valueType ||
                        (option.type === "select" &&
                            !option.values.some((value) => value.value === input.configuration.value))
                    ) {
                        throw new PlatformProjectError(
                            "AGENT_CONFIGURATION_REJECTED",
                            "The harness did not offer the selected model.",
                            409,
                        );
                    }
                    configOptions = (
                        await client.sessions.updateConfiguration(
                            input.runtimeId,
                            sessionId,
                            {
                                agentId: input.agentRef,
                                directoryId: input.workspaceRef,
                                additionalDirectoryIds,
                                configId: input.configuration.configId,
                                value: input.configuration.value,
                                booleanValue: input.configuration.booleanValue,
                                valueType: input.configuration.valueType,
                            },
                            signal,
                        )
                    ).configOptions;
                }
                const access = await client.sessions.createAccess(input.runtimeId, sessionId, 900, signal);
                return {
                    endpoint: this.configuration().origin,
                    projectId,
                    conversationId: sessionId,
                    sessionId,
                    credential: access.credential,
                    expiresAt: access.expiresAt,
                    ready: { ...ready, configOptions },
                    agentRef: input.agentRef,
                    workspaceRef: input.workspaceRef,
                };
            },
            120000,
        );

    readonly queryChatSessions = async (
        projectId: string,
        runtimeId: string,
        sessionIds: readonly string[],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.querySessions(runtimeId, sessionIds, signal),
            120000,
        );

    readonly readChatSession = async (
        projectId: string,
        selection: { readonly runtimeId: string },
        sessionId: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const session = (await client.runtimes.querySessions(selection.runtimeId, [sessionId], signal)).find(
                    (candidate) => candidate.sessionId === sessionId,
                );
                if (session === undefined) {
                    throw new PlatformProjectError("NOT_FOUND", "Your Chat session was not found.", 404);
                }
                const ready = await client.sessions.load(
                    selection.runtimeId,
                    sessionId,
                    {
                        additionalDirectoryIds: session.additionalDirectories.map((item) => item.directoryId),
                        agentId: session.agentId,
                        directoryId: session.directoryId,
                    },
                    signal,
                );
                return {
                    agentRef: session.agentId,
                    ready,
                    entry: {
                        entryId: session.sessionId,
                        mobiusSessionIds: [session.sessionId],
                        nativeSessionId: session.sessionId,
                        title: session.title,
                        directoryId: ready.directoryId,
                        directoryLabel: ready.directoryLabel,
                        additionalDirectories: ready.additionalDirectories,
                        updatedAt: session.updatedAt,
                    },
                };
            },
            120000,
        );

    readonly nativeSessionAccess = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(projectId, signal, async (client) => {
            const access = await client.sessions.createAccess(runtimeId, sessionId, 600, signal);
            return { ...access, endpoint: this.configuration().origin };
        });

    readonly nativeSessions = async (
        projectId: string,
        runtimeId: string,
        request: Parameters<MobiusClient["runtimes"]["nativeSessions"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                return await client.runtimes.nativeSessions(runtimeId, request, signal);
            },
            120000,
        );

    readonly findNativeSessionByNativeSessionId = async (
        projectId: string,
        runtimeId: string,
        request: Parameters<MobiusClient["runtimes"]["findNativeSessionByNativeSessionId"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimes.findNativeSessionByNativeSessionId(runtimeId, request, signal),
            120000,
        );

    readonly readPairing = async (projectId: string, pairingId: string, signal: AbortSignal) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.runtimePairings.read(pairingId, signal),
        );

    readonly #withProject = async <T>(
        projectId: string,
        signal: AbortSignal,
        operation: (client: MobiusClient) => Promise<T>,
        operationTimeoutMilliseconds = 15000,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MobiusClient({
            endpoint: this.configuration().origin,
            projectId: v.parse(platformIdentifier, projectId),
            credentialProvider: new MobiusAppCredentialProvider(
                v.parse(platformCredentialBindingsSchema, this.#bindings).MOBIUS_APP_SECRET,
            ),
            observeResponse: this.#observeMobiusResponse,
            operationTimeoutMilliseconds,
        });
        try {
            return await operation(client);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MobiusTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Platform did not respond in time.", 504, { cause });
            }
            if (cause instanceof MobiusApiError && cause.status === 404) {
                throw new PlatformProjectError("NOT_FOUND", "The Runtime pairing was not found.", 404, { cause });
            }
            if (cause instanceof MobiusError) {
                throw new PlatformProjectError(
                    cause.code,
                    `Platform could not complete Runtime setup. Cause: ${cause.message}`,
                    cause instanceof MobiusApiError ? cause.status : 502,
                    { cause },
                );
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform could not complete Runtime setup.", 502, {
                cause,
            });
        }
    };

    readonly storagePlacement = async (requestedProjectId: string, parent: AbortSignal) => {
        const projectId = v.parse(platformIdentifier, requestedProjectId);
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15000)]);
        try {
            const response = await fetch(
                new URL(
                    `/mobius/api/dashboard/v1/projects/${encodeURIComponent(projectId)}/storage-placement`,
                    this.configuration().origin,
                ),
                {
                    signal,
                    redirect: "manual",
                },
            );
            this.#bindings.requestAccessMetrics?.recordMobiusServerTiming(response.headers.get("server-timing"));
            signal.throwIfAborted();
            if (!response.ok) {
                await response.body?.cancel();
                throw new PlatformProjectError(
                    "PROJECT_PLACEMENT_UNAVAILABLE",
                    "Project placement is unavailable.",
                    503,
                    {
                        cause: new PlatformProjectError(
                            "PLACEMENT_HTTP_ERROR",
                            "Placement endpoint rejected the request.",
                            response.status,
                        ),
                    },
                );
            }
            const value: unknown = await response.json();
            signal.throwIfAborted();
            const placement = v.parse(
                v.strictObject({
                    location: v.picklist(["apac", "wnam"]),
                }),
                value,
            );
            return placement;
        } catch (cause) {
            parent.throwIfAborted();
            if (signal.aborted) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Project placement lookup timed out.", 504, {
                    cause,
                });
            }
            if (cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PROJECT_PLACEMENT_UNAVAILABLE", "Project placement is unavailable.", 503, {
                cause,
            });
        }
    };

    readonly create = async (
        userId: string,
        displayName: string,
        signal: AbortSignal,
        requestedLocationHint?: ProjectLocationHint,
    ) => {
        signal.throwIfAborted();
        const configuration = this.configuration();
        const locationHint = requestedLocationHint ?? "apac";
        const client = new MobiusPlatformAppClient({
            endpoint: configuration.origin,
            credentialProvider: new MobiusAppCredentialProvider(
                v.parse(platformCredentialBindingsSchema, this.#bindings).MOBIUS_APP_SECRET,
            ),
            observeResponse: this.#observeMobiusResponse,
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const project = await client.createProject(
                configuration.appId,
                {
                    clientReference: userId,
                    idempotencyKey: `cloud-${userId}`,
                    displayName,
                    locationHint,
                },
                signal,
            );
            if (
                project.appId !== configuration.appId ||
                project.clientReference !== userId ||
                project.lifecycle !== "active"
            ) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "Platform returned an unexpected Project.",
                    502,
                );
            }
            return v.parse(platformProjectSchema, project);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MobiusTimeoutError) {
                throw new PlatformProjectError("PLATFORM_TIMEOUT", "Platform did not respond in time.", 504, { cause });
            }
            if (cause instanceof MobiusApiError && (cause.status === 401 || cause.status === 403)) {
                throw new PlatformProjectError(
                    "PLATFORM_APP_UNAUTHORIZED",
                    "The Chat App is not authorized to provision Projects.",
                    502,
                    { cause },
                );
            }
            if (cause instanceof MobiusApiError && cause.status === 409) {
                throw new PlatformProjectError(
                    "PLATFORM_PROJECT_CONFLICT",
                    "Project provisioning conflicts with an earlier request.",
                    409,
                    { cause },
                );
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform could not provision the Project.", 502, {
                cause,
            });
        }
    };
}
