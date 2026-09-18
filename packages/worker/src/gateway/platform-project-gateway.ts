import {
    MobiusApiError,
    MobiusAppCredentialProvider,
    MobiusCancellationError,
    MobiusPlatformAppClient,
    MobiusTimeoutError,
} from "@moxt-ai/mobius-sdk/platform";
import {
    MobiusActiveBotState,
    MobiusAgentMessageEvent,
    MobiusBotOwnerClient,
    MobiusCancelledTurnState,
    MobiusClient,
    MobiusFailedTurnState,
    MobiusIndeterminateTurnState,
    MobiusRecordingPolicy,
    MobiusRuntimePairingRequest,
    MobiusSucceededTurnState,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
} from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import {
    PlatformProjectError,
    platformIdentifier,
    platformProjectSchema,
} from "../components/management/entity/platform-project.ts";
import type { ProjectLocationHint } from "../components/management/util/project-location.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export type ChatConversationInput =
    | { readonly conversationId: string }
    | {
          readonly conversationKey: string;
          readonly bindingId: string;
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
            const endpoint = new URL(v.parse(v.string(), this.#bindings.MOBIUS_BASE_URL));
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
                (typeof this.#bindings.APP_ORIGIN === "string" &&
                    endpoint.origin === new URL(this.#bindings.APP_ORIGIN).origin)
            ) {
                throw new Error("Invalid Platform endpoint");
            }
            return { origin: endpoint.origin, appId: v.parse(platformIdentifier, this.#bindings.MOBIUS_APP_ID) };
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
            return { ...pairing, relayUrl: this.configuration().origin };
        });

    readonly chatAgents = async (projectId: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const runtimes = await client.runtimes.list(signal);
            return runtimes.flatMap((runtime) =>
                runtime.agents.map((agent) => ({
                    runtimeId: runtime.runtimeId,
                    agentRef: agent.id,
                    label: agent.label,
                    machineName: runtime.machineName,
                    online: runtime.online,
                })),
            );
        });

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
                    {
                        additionalDirectoryIds: [],
                        agentId: selection.agentRef,
                        directoryId: selection.workspaceRef,
                    },
                    signal,
                );
                if (settings.agentId !== selection.agentRef || settings.directoryId !== selection.workspaceRef) {
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
        selection: {
            readonly bindingId: string;
            readonly runtimeId: string;
            readonly agentRef: string;
            readonly workspaceRef: string;
        },
        input: ChatConversationInput,
        title: string,
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                const sessionId = "conversationId" in input ? input.conversationId : input.conversationKey;
                let session: Awaited<ReturnType<MobiusClient["sessions"]["read"]>>;
                try {
                    session = await client.sessions.read(sessionId, signal);
                } catch (cause) {
                    if (
                        !(cause instanceof MobiusApiError) ||
                        cause.code !== "session_not_found" ||
                        "conversationId" in input
                    ) {
                        throw cause;
                    }
                    session = await client.sessions.create(
                        {
                            agentId: selection.agentRef,
                            bindingId: selection.bindingId,
                            directoryId: selection.workspaceRef,
                            policy: new MobiusRecordingPolicy("full", 30 * 24 * 60 * 60 * 1000, 1000, 6_000_000),
                            runtimeId: selection.runtimeId,
                            sessionId,
                            title,
                        },
                        signal,
                    );
                }
                if (
                    session.projectId !== projectId ||
                    session.sessionId !== sessionId ||
                    session.runtimeId !== selection.runtimeId ||
                    session.agentId !== selection.agentRef
                ) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned an unexpected Session.",
                        502,
                    );
                }
                const ready = await client.sessions.prepare(sessionId, signal);
                if ("conversationKey" in input) {
                    if (!ready.configOptions.some((option) => option.id === input.configuration.configId)) {
                        throw new PlatformProjectError(
                            "AGENT_CONFIGURATION_REJECTED",
                            "The harness did not offer the selected model.",
                            409,
                        );
                    }
                    await client.sessions.updateConfiguration(
                        sessionId,
                        {
                            configId: input.configuration.configId,
                            value: input.configuration.value,
                            booleanValue: input.configuration.booleanValue,
                            valueType: input.configuration.valueType,
                        },
                        signal,
                    );
                }
                const access = await client.sessions.createAccess(sessionId, 900, signal);
                return {
                    endpoint: this.configuration().origin,
                    conversationId: sessionId,
                    sessionId,
                    credential: access.credential,
                    expiresAt: access.expiresAt,
                    ready,
                    agentRef: selection.agentRef,
                    workspaceRef: selection.workspaceRef,
                };
            },
            120000,
        );

    readonly submitChatTurn = async (
        projectId: string,
        sessionId: string,
        request: Parameters<MobiusClient["turns"]["submit"]>[1],
        signal: AbortSignal,
    ) =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => await client.turns.submit(sessionId, request, signal),
        );

    readonly openAutomatedChatSession = async (
        projectId: string,
        selection: {
            readonly bindingId: string;
            readonly runtimeId: string;
            readonly agentRef: string;
            readonly workspaceRef: string;
        },
        sessionId: string,
        title: string,
        signal: AbortSignal,
    ): Promise<string> =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                let session: Awaited<ReturnType<MobiusClient["sessions"]["read"]>>;
                try {
                    session = await client.sessions.read(sessionId, signal);
                } catch (cause) {
                    if (!(cause instanceof MobiusApiError) || cause.code !== "session_not_found") {
                        throw cause;
                    }
                    session = await client.sessions.create(
                        {
                            agentId: selection.agentRef,
                            bindingId: selection.bindingId,
                            directoryId: selection.workspaceRef,
                            policy: new MobiusRecordingPolicy("full", 30 * 24 * 60 * 60 * 1000, 1000, 6_000_000),
                            runtimeId: selection.runtimeId,
                            sessionId,
                            title,
                        },
                        signal,
                    );
                }
                if (
                    session.projectId !== projectId ||
                    session.sessionId !== sessionId ||
                    session.runtimeId !== selection.runtimeId ||
                    session.agentId !== selection.agentRef ||
                    session.defaultBinding.bindingId !== selection.bindingId ||
                    session.defaultBinding.workspaceRef !== selection.workspaceRef
                ) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned an unexpected Session.",
                        502,
                    );
                }
                await client.sessions.prepare(sessionId, signal);
                return sessionId;
            },
            120000,
        );

    readonly submitAutomatedChatTurn = async (
        projectId: string,
        sessionId: string,
        input: {
            readonly commandId: string;
            readonly prompt: string;
            readonly instructions: string;
        },
        signal: AbortSignal,
    ): Promise<{ readonly text: string; readonly stopReason: string }> =>
        await this.#withProject(
            projectId,
            signal,
            async (client) => {
                let text = "";
                let outcome:
                    | { readonly kind: "pending" }
                    | { readonly kind: "completed"; readonly stopReason: string }
                    | { readonly kind: "failed"; readonly code: string; readonly message: string } = {
                    kind: "pending",
                };
                const subscription = await client.events.subscribe(
                    sessionId,
                    "",
                    {
                        receive: async (event) => {
                            const payload = event.payload;
                            if (payload instanceof MobiusAgentMessageEvent && payload.commandId === input.commandId) {
                                text += payload.text;
                            } else if (
                                payload instanceof MobiusTurnCompletedEvent &&
                                payload.commandId === input.commandId
                            ) {
                                outcome = { kind: "completed", stopReason: payload.stopReason };
                                return false;
                            } else if (
                                payload instanceof MobiusTurnFailedEvent &&
                                payload.commandId === input.commandId
                            ) {
                                outcome = { kind: "failed", code: payload.code, message: payload.message };
                                return false;
                            }
                            return true;
                        },
                    },
                    signal,
                );
                try {
                    const turn = await client.turns.submit(
                        sessionId,
                        {
                            additionalDirectoryIds: [],
                            artifactIds: [],
                            content: input.prompt,
                            idempotencyKey: input.commandId,
                            images: [],
                            resources:
                                input.instructions.trim().length === 0
                                    ? []
                                    : [
                                          {
                                              type: "embedded",
                                              uri: "mobius-chat://bot/instructions",
                                              name: "Bot instructions",
                                              mimeType: "text/plain",
                                              text: input.instructions,
                                          },
                                      ],
                        },
                        signal,
                    );
                    try {
                        await subscription.completed;
                    } catch (streamCause) {
                        const current = await client.turns.read(sessionId, turn.turnId, signal);
                        if (current.state instanceof MobiusSucceededTurnState) {
                            outcome = { kind: "completed", stopReason: current.state.stopReason };
                        } else if (current.state instanceof MobiusCancelledTurnState) {
                            outcome = { kind: "completed", stopReason: "cancelled" };
                        } else if (current.state instanceof MobiusFailedTurnState) {
                            outcome = { kind: "failed", code: current.state.code, message: current.state.message };
                        } else if (current.state instanceof MobiusIndeterminateTurnState) {
                            throw new PlatformProjectError(
                                "TURN_INDETERMINATE",
                                "The agent Turn outcome is unavailable.",
                                502,
                                { cause: streamCause },
                            );
                        } else {
                            throw streamCause;
                        }
                    }
                    if (outcome.kind === "failed") {
                        throw new PlatformProjectError(outcome.code, outcome.message, 502);
                    }
                    if (outcome.kind === "pending") {
                        throw new PlatformProjectError(
                            "TURN_OUTCOME_UNAVAILABLE",
                            "The agent Turn ended without an outcome.",
                            502,
                        );
                    }
                    return { text, stopReason: outcome.stopReason };
                } finally {
                    subscription.close();
                }
            },
            600000,
        );

    readonly migrateLegacyBot = async (projectId: string, botId: string, userId: string, signal: AbortSignal) =>
        await this.#withBot(projectId, botId, userId, signal, async (client, bot) => {
            if (!(bot.state instanceof MobiusActiveBotState)) {
                return { configuration: null, instructions: "" };
            }
            const activeState = bot.state;
            const [bindings, behaviors] = await Promise.all([
                client.listBindings(botId, signal),
                client.listBehaviors(botId, signal),
            ]);
            const binding = bindings.executionBindings.find((item) => item.bindingId === activeState.activeBindingId);
            const behavior = behaviors.behaviorRevisions.find(
                (item) => item.behaviorRevisionId === activeState.activeBehaviorRevisionId,
            );
            if (binding === undefined || behavior === undefined) {
                throw new PlatformProjectError(
                    "PLATFORM_INVALID_RESPONSE",
                    "The legacy Bot configuration is incomplete.",
                    502,
                );
            }
            return {
                configuration: {
                    bindingId: binding.bindingId,
                    runtimeId: binding.runtimeId,
                    agentRef: binding.agentRef,
                    workspaceRef: binding.workspaceRef,
                    agentConfigRevision: binding.agentConfigRevision,
                },
                instructions: behavior.instructions,
            };
        });

    readonly nativeSessionAccess = async (projectId: string, sessionId: string, signal: AbortSignal) =>
        await this.#withProject(projectId, signal, async (client) => {
            const access = await client.sessions.createAccess(sessionId, 600, signal);
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

    readonly #withBot = async <T>(
        projectId: string,
        botId: string,
        actorReference: string,
        signal: AbortSignal,
        operation: (
            client: MobiusBotOwnerClient,
            bot: Awaited<ReturnType<MobiusBotOwnerClient["readBot"]>>,
        ) => Promise<T>,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MobiusBotOwnerClient({
            endpoint: this.configuration().origin,
            projectId,
            actorReference,
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            observeResponse: this.#observeMobiusResponse,
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const bot = await client.readBot(botId, signal);
            if (bot.projectId !== projectId) {
                throw new PlatformProjectError("NOT_FOUND", "Your Bot was not found.", 404);
            }
            return await operation(client, bot);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            if (cause instanceof MobiusTimeoutError) {
                throw new PlatformProjectError("CHAT_TIMEOUT", "The agent did not respond in time.", 504, { cause });
            }
            if (cause instanceof MobiusApiError) {
                throw new PlatformProjectError(cause.code, "The agent could not complete the request.", cause.status, {
                    cause,
                });
            }
            throw new PlatformProjectError("CHAT_UNAVAILABLE", "Chat is temporarily unavailable.", 502, { cause });
        }
    };

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
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
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
            if (cause instanceof MobiusApiError) {
                throw new PlatformProjectError(cause.code, "Platform could not complete Runtime setup.", cause.status, {
                    cause,
                });
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Platform could not complete Runtime setup.", 502, {
                cause,
            });
        } finally {
            client.close();
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
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
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
