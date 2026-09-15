import * as v from "valibot";
import { type MobiusBinding, mobiusBindingSchema } from "../components/slack/entity/mobius-binding";

export type { MobiusBinding } from "../components/slack/entity/mobius-binding";

export interface MobiusTransport {
    readonly request: (path: string, init?: RequestInit) => Promise<Response>;
}

export class FetchMobiusTransport implements MobiusTransport {
    readonly #appId: unknown;
    readonly #appSecret: unknown;
    readonly #baseUrl: unknown;
    readonly #forbiddenOrigin: unknown;
    constructor(configuration: {
        readonly appId: unknown;
        readonly appSecret: unknown;
        readonly baseUrl: unknown;
        readonly forbiddenOrigin: unknown;
    }) {
        this.#appId = configuration.appId;
        this.#appSecret = configuration.appSecret;
        this.#baseUrl = configuration.baseUrl;
        this.#forbiddenOrigin = configuration.forbiddenOrigin;
    }

    readonly request = async (path: string, init?: RequestInit): Promise<Response> => {
        if (!path.startsWith("/mobius/api/") || path.startsWith("//")) {
            throw new MobiusGatewayError("MOBIUS_REQUEST_INVALID", "The Mobius request path is invalid");
        }
        const baseUrl = this.#validatedBaseUrl();
        const headers = new Headers(init?.headers);
        headers.set("x-mobius-app-id", v.parse(v.pipe(v.string(), v.minLength(1)), this.#appId));
        headers.set("x-mobius-app-secret", v.parse(v.pipe(v.string(), v.minLength(1)), this.#appSecret));
        return await fetch(new Request(new URL(path, baseUrl), { ...init, headers, redirect: "manual" }));
    };

    readonly #validatedBaseUrl = (): URL => {
        const baseUrl = new URL(v.parse(v.string(), this.#baseUrl));
        if (
            (baseUrl.protocol !== "https:" &&
                !(baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname))) ||
            baseUrl.username !== "" ||
            baseUrl.password !== "" ||
            baseUrl.pathname !== "/" ||
            baseUrl.search !== "" ||
            baseUrl.hash !== "" ||
            (typeof this.#forbiddenOrigin === "string" && baseUrl.origin === new URL(this.#forbiddenOrigin).origin)
        ) {
            throw new MobiusGatewayError("MOBIUS_CONFIGURATION_INVALID", "The Mobius service is not configured");
        }
        return baseUrl;
    };
}

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
export const botBindingInputSchema = v.pipe(
    v.object({
        botId: identifier,
        ownerCredential: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
    }),
    v.readonly(),
);
export type BotBindingInput = v.InferOutput<typeof botBindingInputSchema>;
export const createMobiusBotSchema = v.pipe(
    v.object({
        displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
        description: v.pipe(v.string(), v.maxLength(2000)),
        ownerCredential: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
    }),
    v.readonly(),
);
const managedBotSchema = v.pipe(
    v.object({
        botId: identifier,
        displayName: v.string(),
        lifecycle: v.string(),
        setupStatus: v.optional(v.string()),
    }),
    v.readonly(),
);
export const botSetupCredentialSchema = v.object({
    ownerCredential: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
});
export const configureBotSchema = v.object({
    ...botSetupCredentialSchema.entries,
    runtimeId: identifier,
    agentRef: identifier,
    workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    instructions: v.pipe(v.string(), v.maxLength(100000)),
    lifecycleRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    behaviorRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const configuredStateSchema = v.object({
    kind: v.picklist(["requested", "approved", "unavailable", "revoked"]),
    runtimeId: identifier,
    agentRef: identifier,
    workspaceRef: v.string(),
    instructions: v.string(),
    allowedDeliveryTargetIds: v.array(identifier),
    completionPolicy: v.record(v.string(), v.unknown()),
});
const setupStateSchema = v.object({
    lifecycle: v.string(),
    lifecycleRevision: v.number(),
    behaviorRevision: v.number(),
    configuration: v.union([v.object({ kind: v.literal("not-configured") }), configuredStateSchema]),
});
const runtimeSchema = v.object({
    runtimeId: identifier,
    machineName: v.string(),
    workspaceName: v.string(),
    online: v.boolean(),
    agents: v.array(v.object({ id: identifier, label: v.string() })),
});
export const pairingStatusInputSchema = v.object({
    pairingId: identifier,
    pollToken: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
});
const createdPairingSchema = v.object({
    channelId: identifier,
    tenantId: identifier,
    pairingId: identifier,
    projectId: identifier,
    pairingCode: v.pipe(v.string(), v.regex(/^[A-Z0-9-]+$/u)),
    pollToken: v.string(),
    hostToken: v.string(),
    expiresAt: v.string(),
});

export class MobiusGatewayError extends Error {
    readonly toResponse = (): Response =>
        Response.json(
            { error: { code: this.code, message: this.message } },
            { status: this.code === "MOBIUS_BINDING_NOT_CONFIGURED" ? 400 : 502 },
        );
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.name = "MobiusGatewayError";
    }
}

export class MobiusGateway {
    readonly #transport: MobiusTransport;
    constructor(cx: { readonly gateways: { readonly mobiusTransport: MobiusTransport } }) {
        this.#transport = cx.gateways.mobiusTransport;
    }

    readonly listProjects = async (credential: string | null, signal: AbortSignal) => {
        return v.parse(
            v.object({ projects: v.array(v.object({ projectId: identifier, displayName: v.string() })) }),
            await this.#request("/v1/projects", credential, null, signal),
        );
    };

    /** tenantId comes from the authenticated user for user-owned bot pairing. */
    readonly createPairing = async (credential: string | null, signal: AbortSignal, _tenantId: string) =>
        v.parse(createdPairingSchema, await this.#request("/pairings", credential, {}, signal));

    readonly pairingStatus = async (input: v.InferOutput<typeof pairingStatusInputSchema>, signal: AbortSignal) =>
        v.parse(
            v.object({ status: v.picklist(["pending", "paired", "expired"]) }),
            await this.#request(
                `/pairings/${encodeURIComponent(input.pairingId)}?token=${encodeURIComponent(input.pollToken)}`,
                null,
                null,
                signal,
            ),
        );

    readonly projectStatus = async (projectId: string, credential: string | null, signal: AbortSignal) => {
        v.parse(identifier, projectId);
        return v.parse(
            v.object({ status: v.picklist(["connected", "offline"]) }),
            await this.#request(`/v1/projects/${encodeURIComponent(projectId)}/status`, credential, null, signal),
        );
    };

    readonly listProjectBots = async (projectId: string, credential: string | null, signal: AbortSignal) => {
        v.parse(identifier, projectId);
        return v.parse(
            v.object({ bots: v.array(managedBotSchema) }),
            await this.#request(`/v1/projects/${encodeURIComponent(projectId)}/bots`, credential, null, signal),
        );
    };

    readonly createBot = async (
        projectId: string,
        credential: string | null,
        input: v.InferOutput<typeof createMobiusBotSchema>,
        signal: AbortSignal,
    ) => {
        await this.listProjectBots(projectId, credential, signal);
        return v.parse(
            managedBotSchema,
            await this.#request(
                `/v1/projects/${encodeURIComponent(projectId)}/bots`,
                input.ownerCredential,
                { displayName: input.displayName, description: input.description, avatarRef: "" },
                signal,
            ),
        );
    };

    readonly botSetup = async (
        projectId: string,
        botId: string,
        ownerCredential: string,
        credential: string | null,
        signal: AbortSignal,
    ) => {
        v.parse(identifier, botId);
        const { bots } = await this.listProjectBots(projectId, credential, signal);
        if (!bots.some((bot) => bot.botId === botId)) {
            throw new MobiusGatewayError("MOBIUS_BOT_NOT_FOUND", "This bot does not belong to the selected project");
        }
        const [setup, runtimes] = await Promise.all([
            this.#request(`/v1/bots/${encodeURIComponent(botId)}/setup`, ownerCredential, null, signal),
            this.#request(`/projects/${encodeURIComponent(projectId)}/runtimes`, ownerCredential, null, signal),
        ]);
        return {
            ...v.parse(setupStateSchema, setup),
            runtimes: v.parse(v.object({ runtimes: v.array(runtimeSchema) }), runtimes).runtimes,
        };
    };

    readonly configureBot = async (
        projectId: string,
        botId: string,
        input: v.InferOutput<typeof configureBotSchema>,
        credential: string | null,
        signal: AbortSignal,
    ) => {
        const current = await this.botSetup(projectId, botId, input.ownerCredential, credential, signal);
        const runtime = current.runtimes.find((candidate) => candidate.runtimeId === input.runtimeId);
        if (runtime === undefined || !runtime.agents.some((agent) => agent.id === input.agentRef)) {
            throw new MobiusGatewayError("MOBIUS_AGENT_UNAVAILABLE", "Choose an available agent in this project");
        }
        if (
            current.lifecycleRevision !== input.lifecycleRevision ||
            current.behaviorRevision !== input.behaviorRevision
        ) {
            throw new MobiusGatewayError("MOBIUS_REVISION_CONFLICT", "Bot setup changed. Refresh and try again");
        }
        if (current.configuration.kind === "requested") {
            throw new MobiusGatewayError(
                "MOBIUS_APPROVAL_PENDING",
                "The runtime has not resolved the previous setup request yet",
            );
        }
        const behavior = v.parse(
            v.object({ behaviorRevisionId: identifier }),
            await this.#request(
                `/v1/bots/${encodeURIComponent(botId)}/behavior-revisions`,
                input.ownerCredential,
                {
                    expectedRevision: current.behaviorRevision,
                    instructions: input.instructions,
                    requiredCapabilities: input.instructions.trim() === "" ? [] : ["embedded-context"],
                    agentConfiguration: {},
                },
                signal,
            ),
        );
        await this.#request(
            `/v1/bots/${encodeURIComponent(botId)}/execution-bindings`,
            input.ownerCredential,
            {
                expectedRevision: current.lifecycleRevision,
                behaviorRevisionId: behavior.behaviorRevisionId,
                runtimeId: input.runtimeId,
                agentRef: input.agentRef,
                workspaceRef: input.workspaceRef,
                agentConfigRevision: 1,
                allowedDeliveryTargetIds:
                    current.configuration.kind === "not-configured"
                        ? []
                        : current.configuration.allowedDeliveryTargetIds,
                completionPolicy:
                    current.configuration.kind === "not-configured"
                        ? { kind: "none" }
                        : current.configuration.completionPolicy,
            },
            signal,
        );
        return await this.botSetup(projectId, botId, input.ownerCredential, credential, signal);
    };

    readonly connectBot = async (
        tenantId: string,
        slackBotId: string,
        grant: BotBindingInput,
        signal: AbortSignal,
    ): Promise<MobiusBinding> => {
        const connectorPrincipalId = `slack:${tenantId}:${slackBotId}`;
        const issued = v.parse(
            v.object({ grantId: identifier, grantSecret: v.string() }),
            await this.#request(
                `/v1/bots/${encodeURIComponent(grant.botId)}/connection-grants`,
                grant.ownerCredential,
                {
                    audience: "slack",
                    expiresInSeconds: 300,
                    label: connectorPrincipalId,
                    scopes: ["inbound-conversation:create", "inbound-message:create", "conversation-events:read"],
                },
                signal,
            ),
        );
        const result = v.parse(
            v.object({
                botId: identifier,
                connectionId: identifier,
                credential: v.pipe(v.string(), v.minLength(32)),
                audience: v.literal("slack"),
                connectorPrincipalId: v.literal(connectorPrincipalId),
                lifecycle: v.literal("active"),
                scopes: v.array(v.string()),
            }),
            await this.#request(
                "/v1/bot-connection-grants/redeem",
                null,
                {
                    audience: "slack",
                    connectorPrincipalId,
                    grantId: issued.grantId,
                    grantSecret: issued.grantSecret,
                },
                signal,
            ),
        );
        if (
            result.botId !== grant.botId ||
            !["inbound-conversation:create", "inbound-message:create", "conversation-events:read"].every((scope) =>
                result.scopes.includes(scope),
            )
        ) {
            throw new MobiusGatewayError("MOBIUS_BINDING_INVALID", "The grant does not authorize this bot connection");
        }
        try {
            const target = v.parse(
                v.object({ deliveryTargetId: identifier }),
                await this.#request(
                    `/v1/bot-connections/${encodeURIComponent(result.connectionId)}/delivery-targets`,
                    result.credential,
                    { alias: "slack-replies" },
                    signal,
                ),
            );
            await this.#request(
                `/v1/bots/${encodeURIComponent(result.botId)}/delivery-targets/${encodeURIComponent(target.deliveryTargetId)}/approve`,
                grant.ownerCredential,
                { expectedPolicyRevision: 0 },
                signal,
            );
            return v.parse(mobiusBindingSchema, {
                tenantId,
                slackBotId,
                botId: result.botId,
                connectionId: result.connectionId,
                deliveryTargetId: target.deliveryTargetId,
                credential: result.credential,
            });
        } catch (cause) {
            try {
                await this.revoke(result, AbortSignal.timeout(10_000));
            } finally {
                signal.throwIfAborted();
            }
            throw cause;
        }
    };

    readonly revoke = async (
        connection: { readonly connectionId: string; readonly credential: string },
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#request(
            `/v1/bot-connections/${encodeURIComponent(connection.connectionId)}/revoke`,
            connection.credential,
            {},
            signal,
        );
    };

    readonly createConversation = async (binding: MobiusBinding, key: string, signal: AbortSignal): Promise<string> => {
        const conversation = v.parse(
            v.object({ conversationId: identifier }),
            await this.#request(
                `/v1/bots/${encodeURIComponent(binding.botId)}/conversations`,
                binding.credential,
                {
                    clientConversationKey: key,
                    replyDeliveryTargetId: binding.deliveryTargetId,
                    title: "Slack conversation",
                },
                signal,
            ),
        );
        return conversation.conversationId;
    };

    readonly prompt = async (
        input: {
            readonly binding: MobiusBinding;
            readonly clientMessageId: string;
            readonly conversationId: string;
            readonly prompt: string;
            readonly actorRef: string;
        },
        signal: AbortSignal,
    ): Promise<{ readonly text: string; readonly stopReason: string }> => {
        return await withDeadline(signal, 600_000, async (deadline) => {
            const path = `/v1/bots/${encodeURIComponent(input.binding.botId)}/conversations/${encodeURIComponent(input.conversationId)}`;
            const accepted = v.parse(
                v.object({ turnId: identifier }),
                await this.#request(
                    `${path}/messages`,
                    input.binding.credential,
                    {
                        actorRef: input.actorRef,
                        clientMessageId: input.clientMessageId,
                        resourceRefs: [],
                        text: input.prompt,
                    },
                    deadline,
                ),
            );
            let cursor = "";
            let text = "";
            for (;;) {
                deadline.throwIfAborted();
                const page = v.parse(
                    v.object({
                        cursor: v.string(),
                        hasMore: v.boolean(),
                        events: v.array(
                            v.object({
                                turnId: v.nullable(v.string()),
                                kind: v.string(),
                                payload: v.record(v.string(), v.unknown()),
                            }),
                        ),
                    }),
                    await this.#request(
                        `${path}/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
                        input.binding.credential,
                        null,
                        deadline,
                    ),
                );
                for (const event of page.events) {
                    if (event.turnId !== accepted.turnId) {
                        continue;
                    }
                    if (event.kind === "agent.message.delta") {
                        text += v.parse(v.object({ text: v.string() }), event.payload).text;
                    }
                    if (event.kind === "session.completed") {
                        return {
                            text,
                            stopReason: v.parse(v.object({ stopReason: v.string() }), event.payload).stopReason,
                        };
                    }
                    if (event.kind === "session.failed") {
                        throw new MobiusGatewayError(
                            "MOBIUS_TURN_FAILED",
                            "The Mobius bot could not complete the message",
                        );
                    }
                }
                cursor = page.cursor;
                if (!page.hasMore) {
                    await waitForEvents(deadline);
                }
            }
        });
    };

    readonly #request = async (
        path: string,
        credential: string | null,
        body: unknown,
        signal: AbortSignal,
    ): Promise<unknown> => {
        return await withDeadline(signal, 20_000, async (deadline) => {
            try {
                const response = await this.#transport.request(`/mobius/api${path}`, {
                    method: body === null ? "GET" : "POST",
                    redirect: "manual",
                    signal: deadline,
                    headers: {
                        "Content-Type": "application/json",
                        ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
                    },
                    ...(body === null ? {} : { body: JSON.stringify(body) }),
                });
                if (!response.ok) {
                    throw new MobiusGatewayError("MOBIUS_REQUEST_FAILED", "Mobius rejected the bot request");
                }
                return await response.json();
            } catch (cause) {
                deadline.throwIfAborted();
                if (cause instanceof MobiusGatewayError) {
                    throw cause;
                }
                throw new MobiusGatewayError("MOBIUS_CONNECTION_FAILED", "Unable to reach the Mobius Bot API", {
                    cause,
                });
            }
        });
    };
}

async function withDeadline<T>(
    signal: AbortSignal,
    milliseconds: number,
    operation: (deadline: AbortSignal) => Promise<T>,
): Promise<T> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new DOMException("Mobius request timed out", "TimeoutError")),
        milliseconds,
    );
    try {
        return await operation(AbortSignal.any([signal, controller.signal]));
    } finally {
        clearTimeout(timer);
    }
}

async function waitForEvents(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, 500);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}
