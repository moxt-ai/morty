import {
    MobiusApiError,
    MobiusAppCredentialProvider,
    MobiusCancellationError,
    MobiusPlatformAppClient,
    MobiusTimeoutError,
} from "@moxt-ai/mobius-sdk/platform";
import {
    MobiusActiveBotState,
    MobiusBotOwnerClient,
    MobiusClient,
    MobiusNoBotCompletionPolicy,
    MobiusRecordingPolicy,
    MobiusRuntimePairingRequest,
} from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import {
    PlatformProjectError,
    platformIdentifier,
    platformProjectSchema,
} from "../components/management/entity/platform-project.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import type { OperationTiming } from "../infra/operation-timing.ts";

export type ChatConversationInput =
    | { readonly conversationId: string }
    | {
          readonly conversationKey: string;
          readonly bindingId: string;
          readonly configuration: NonNullable<
              Parameters<MobiusBotOwnerClient["createProjectConversation"]>[0]["configuration"]
          >;
      };

const platformTimingMetric = /^([a-z][a-z0-9-]{0,63});dur=(\d+(?:\.\d+)?);desc="([^"\\]{1,120})"$/u;

function recordPlatformTiming(encoded: string | null, prefix: string, timing: OperationTiming): void {
    if (encoded === null || encoded.length > 8_192) {
        return;
    }
    for (const entry of encoded.split(",")) {
        const match = platformTimingMetric.exec(entry.trim());
        if (match === null) {
            continue;
        }
        const [, name, duration, description] = match;
        if (name === undefined || duration === undefined || description === undefined) {
            continue;
        }
        const durationMilliseconds = Number(duration);
        if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0 || durationMilliseconds > 120_000) {
            continue;
        }
        if (name === "total") {
            timing.record("mobius", "Mobius access", durationMilliseconds);
        }
        timing.record(`platform-${prefix}-${name}`, `Platform: ${description}`, durationMilliseconds);
    }
}

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

    readonly createBot = async (projectId: string, signal: AbortSignal) => {
        const client = new MobiusBotOwnerClient({
            endpoint: this.configuration().origin,
            projectId,
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            observeResponse: this.#observeMobiusResponse,
            operationTimeoutMilliseconds: 15000,
        });
        try {
            const bot = await client.createBot({ displayName: "My Bot", description: "", avatarRef: "" }, signal);
            if (bot.projectId !== projectId) {
                throw new PlatformProjectError("PLATFORM_INVALID_RESPONSE", "The Bot could not be verified.", 502);
            }
            return { botId: bot.botId, displayName: bot.displayName };
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof MobiusCancellationError || cause instanceof PlatformProjectError) {
                throw cause;
            }
            throw new PlatformProjectError("PLATFORM_UNAVAILABLE", "Your Bot could not be created.", 502, { cause });
        }
    };

    readonly configureBot = async (
        projectId: string,
        botId: string,
        actorReference: string,
        input: {
            readonly runtimeId: string;
            readonly agentRef: string;
            readonly workspaceRef: string;
            readonly agentConfigRevision: number;
        },
        signal: AbortSignal,
    ) => {
        return await this.#withBot(projectId, botId, actorReference, signal, async (client, bot) => {
            if (bot.state.kind !== "draft" && bot.state.kind !== "active") {
                throw new PlatformProjectError("BOT_UNAVAILABLE", "Your Bot cannot be configured.", 409);
            }
            const [behaviors, bindings] = await Promise.all([
                client.listBehaviors(botId, signal),
                client.listBindings(botId, signal),
            ]);
            const activeState = bot.state;
            const activeBinding =
                activeState instanceof MobiusActiveBotState
                    ? bindings.executionBindings.find((binding) => binding.bindingId === activeState.activeBindingId)
                    : undefined;
            if (
                activeBinding !== undefined &&
                activeBinding.runtimeId === input.runtimeId &&
                activeBinding.agentRef === input.agentRef &&
                activeBinding.workspaceRef === input.workspaceRef &&
                activeBinding.agentConfigRevision === input.agentConfigRevision
            ) {
                return { status: "active" };
            }
            const pending = bindings.executionBindings.find((binding) => binding.state.kind === "requested");
            if (pending !== undefined) {
                if (
                    pending.runtimeId !== input.runtimeId ||
                    pending.agentRef !== input.agentRef ||
                    pending.workspaceRef !== input.workspaceRef ||
                    pending.agentConfigRevision !== input.agentConfigRevision
                ) {
                    throw new PlatformProjectError(
                        "BOT_SETUP_PENDING",
                        "The Runtime has not resolved the previous Bot setup request.",
                        409,
                    );
                }
                return {
                    bindingId: pending.bindingId,
                    bindingRevision: pending.bindingRevision,
                    lifecycle: "requested",
                };
            }
            const runtimes = await this.#withProject(
                projectId,
                signal,
                async (projectClient) => await projectClient.runtimes.list(signal),
            );
            const runtime = runtimes.find(
                (candidate) => candidate.projectId === projectId && candidate.runtimeId === input.runtimeId,
            );
            if (runtime === undefined || !runtime.agents.some((agent) => agent.id === input.agentRef)) {
                throw new PlatformProjectError(
                    "AGENT_UNAVAILABLE",
                    "Choose an available agent on your connected Runtime.",
                    409,
                );
            }
            const activeBehavior =
                activeState instanceof MobiusActiveBotState
                    ? behaviors.behaviorRevisions.find(
                          (revision) => revision.behaviorRevisionId === activeState.activeBehaviorRevisionId,
                      )
                    : undefined;
            const behavior =
                behaviors.behaviorRevisions.find((revision) => revision.state.kind === "proposed") ??
                (await client.createBehavior(
                    botId,
                    {
                        expectedRevision: Math.max(
                            0,
                            ...behaviors.behaviorRevisions.map((revision) => revision.revisionNumber),
                        ),
                        instructions: activeBehavior?.instructions ?? "Be a helpful assistant.",
                        agentConfiguration: activeBehavior?.agentConfiguration ?? {},
                        requiredCapabilities: activeBehavior?.requiredCapabilities ?? ["embedded-context"],
                    },
                    signal,
                ));
            return await client.createBinding(
                botId,
                {
                    ...input,
                    behaviorRevisionId: behavior.behaviorRevisionId,
                    expectedRevision: bot.lifecycleRevision,
                    allowedDeliveryTargetIds: [],
                    completionPolicy: new MobiusNoBotCompletionPolicy(),
                },
                signal,
            );
        });
    };

    readonly chatWorkspace = async (projectId: string, botId: string, userId: string, signal: AbortSignal) =>
        await this.#withBot(projectId, botId, userId, signal, async (owner, bot) => {
            const [runtimes, bindings] = await Promise.all([
                this.#withProject(projectId, signal, (client) => client.runtimes.list(signal)),
                owner.listBindings(botId, signal),
            ]);
            const state = bot.state;
            const active =
                state instanceof MobiusActiveBotState
                    ? bindings.executionBindings.find((binding) => binding.bindingId === state.activeBindingId)
                    : undefined;
            return {
                status: bot.state.kind,
                selected:
                    active === undefined
                        ? null
                        : {
                              runtimeId: active.runtimeId,
                              agentRef: active.agentRef,
                              workspaceRef: active.workspaceRef,
                              agentConfigRevision: active.agentConfigRevision,
                          },
                agents: runtimes.flatMap((runtime) =>
                    runtime.agents.map((agent) => ({
                        runtimeId: runtime.runtimeId,
                        agentRef: agent.id,
                        label: agent.label,
                        machineName: runtime.machineName,
                        online: runtime.online,
                    })),
                ),
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

    readonly openChat = async (
        projectId: string,
        botId: string,
        userId: string,
        signal: AbortSignal,
        input: ChatConversationInput,
        timing: OperationTiming,
    ) =>
        await this.#withBot(
            projectId,
            botId,
            userId,
            signal,
            async (client, bot) => {
                if (!(bot.state instanceof MobiusActiveBotState)) {
                    throw new PlatformProjectError(
                        "AGENT_REQUIRED",
                        "Connect your local agent to start chatting.",
                        409,
                    );
                }
                if ("conversationKey" in input && input.bindingId !== bot.state.activeBindingId) {
                    throw new PlatformProjectError(
                        "AGENT_CHANGED",
                        "Your selected harness changed. Reload its settings before sending.",
                        409,
                    );
                }
                const conversation =
                    "conversationId" in input
                        ? await timing.measure(
                              "conversation",
                              "Read Conversation",
                              async () => await client.readProjectConversation(input.conversationId, signal),
                          )
                        : await timing.measure(
                              "conversation",
                              "Create and configure Conversation",
                              async () =>
                                  await client.createProjectConversation(
                                      {
                                          botId,
                                          clientReference: input.conversationKey,
                                          idempotencyKey: input.conversationKey,
                                          title: "New chat",
                                          configuration: input.configuration,
                                      },
                                      signal,
                                  ),
                          );
                if (
                    conversation.botId !== botId ||
                    conversation.projectId !== projectId ||
                    ("conversationKey" in input &&
                        (conversation.bindingId !== input.bindingId ||
                            conversation.clientReference !== input.conversationKey ||
                            conversation.idempotencyKey !== input.conversationKey)) ||
                    ("conversationId" in input && conversation.conversationId !== input.conversationId) ||
                    conversation.lifecycle !== "active"
                ) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned an unexpected Conversation.",
                        502,
                    );
                }
                const configuration = this.configuration();
                if ("conversationKey" in input) {
                    const ready = conversation.ready;
                    if (ready === null || ready.sessionId !== conversation.sessionId) {
                        throw new PlatformProjectError(
                            "PLATFORM_INVALID_RESPONSE",
                            "Platform returned an unexpected Session.",
                            502,
                        );
                    }
                    const requested = input.configuration;
                    if (
                        !ready.configOptions.some(
                            (option) => option.id === requested.configId && option.currentValue === requested.value,
                        )
                    ) {
                        throw new PlatformProjectError(
                            "AGENT_CONFIGURATION_REJECTED",
                            "The harness did not confirm the selected model. Choose a model before retrying your message.",
                            409,
                        );
                    }
                }
                const platform = new MobiusPlatformAppClient({
                    endpoint: configuration.origin,
                    credentialProvider: new MobiusAppCredentialProvider(
                        v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET),
                    ),
                    observeResponse: ({ serverTiming }: { readonly serverTiming: string | null }) => {
                        this.#observeMobiusResponse({ serverTiming });
                        recordPlatformTiming(serverTiming, "credential", timing);
                    },
                    operationTimeoutMilliseconds: 15000,
                });
                const permissions = [
                    "conversation:read",
                    "conversation:event:read",
                    "conversation:message:create",
                    "conversation:turn:create",
                    "conversation:configure",
                ] as const;
                const access = await timing.measure(
                    "credential",
                    "Issue Conversation access credential",
                    async () =>
                        await platform.issueConversationAccessCredential(
                            projectId,
                            conversation.conversationId,
                            {
                                actorRef: userId,
                                expiresInSeconds: 900,
                                permissions,
                            },
                            signal,
                        ),
                );
                if (
                    access.appId !== configuration.appId ||
                    access.projectId !== projectId ||
                    access.conversationId !== conversation.conversationId ||
                    access.sessionId !== conversation.sessionId ||
                    access.actorRef !== userId ||
                    permissions.some((permission) => !access.permissions.includes(permission))
                ) {
                    throw new PlatformProjectError(
                        "PLATFORM_INVALID_RESPONSE",
                        "Platform returned unexpected Chat access.",
                        502,
                    );
                }
                return {
                    endpoint: configuration.origin,
                    conversationId: conversation.conversationId,
                    credential: access.credential,
                    expiresAt: access.expiresAt,
                };
            },
            timing,
            120000,
        );

    readonly draftSettings = async (projectId: string, botId: string, userId: string, signal: AbortSignal) =>
        await this.#withBot(projectId, botId, userId, signal, async (owner, bot) => {
            const state = bot.state;
            if (!(state instanceof MobiusActiveBotState)) {
                throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
            }
            const bindings = await owner.listBindings(botId, signal);
            const binding = bindings.executionBindings.find((item) => item.bindingId === state.activeBindingId);
            if (binding === undefined) {
                throw new PlatformProjectError("AGENT_REQUIRED", "Choose a connected harness.", 409);
            }
            return await this.#withProject(
                projectId,
                signal,
                async (client) => {
                    const sessionId = `settings-${crypto.randomUUID()}`;
                    try {
                        await client.sessions.create(
                            {
                                sessionId,
                                runtimeId: binding.runtimeId,
                                agentId: binding.agentRef,
                                directoryId: binding.workspaceRef,
                                bindingId: binding.bindingId,
                                title: "Chat settings",
                                policy: new MobiusRecordingPolicy("summary", 60000, 10, 1024),
                            },
                            signal,
                        );
                        const ready = await client.sessions.prepare(sessionId, signal);
                        if (ready.sessionId !== sessionId || ready.agentId !== binding.agentRef) {
                            throw new PlatformProjectError(
                                "PLATFORM_INVALID_RESPONSE",
                                "Platform returned unexpected harness settings.",
                                502,
                            );
                        }
                        return { bindingId: binding.bindingId, ready };
                    } finally {
                        // Cleanup must also run after the caller cancels preparation.
                        await client.sessions.delete(sessionId, AbortSignal.timeout(15000)).catch((cause: unknown) => {
                            signal.throwIfAborted();
                            if (!(cause instanceof MobiusApiError && cause.status === 404)) {
                                throw cause;
                            }
                        });
                    }
                },
                120000,
            );
        });

    readonly #withBot = async <T>(
        projectId: string,
        botId: string,
        actorReference: string,
        signal: AbortSignal,
        operation: (
            client: MobiusBotOwnerClient,
            bot: Awaited<ReturnType<MobiusBotOwnerClient["readBot"]>>,
        ) => Promise<T>,
        timing?: OperationTiming,
        operationTimeoutMilliseconds = 15000,
    ): Promise<T> => {
        signal.throwIfAborted();
        const client = new MobiusBotOwnerClient({
            endpoint: this.configuration().origin,
            projectId,
            actorReference,
            credentialProvider: new MobiusAppCredentialProvider(v.parse(v.string(), this.#bindings.MOBIUS_APP_SECRET)),
            ...(timing === undefined
                ? { observeResponse: this.#observeMobiusResponse }
                : {
                      observeResponse: ({ serverTiming }: { readonly serverTiming: string | null }) => {
                          this.#observeMobiusResponse({ serverTiming });
                          recordPlatformTiming(serverTiming, "conversation", timing);
                      },
                  }),
            operationTimeoutMilliseconds,
        });
        try {
            const bot =
                timing === undefined
                    ? await client.readBot(botId, signal)
                    : await timing.measure("bot", "Read Bot", async () => await client.readBot(botId, signal));
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
        requestedLocationHint?: "apac" | "wnam",
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
