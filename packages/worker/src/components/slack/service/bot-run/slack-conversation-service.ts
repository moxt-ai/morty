import type { ChatBotBinding } from "../../entity/chat-bot-binding.ts";
import type { SlackPlatformGateway } from "../../entity/slack-platform-gateway.ts";
import { SlackServiceError } from "../../entity/slack-service-error.ts";
import type { SlackLogger } from "../../infra/util/logger";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { TenantContext } from "../identity/tenant-context";
import type { ChatBotBindingService } from "../installation/chat-bot-binding-service";
import type { SlackContextLoader } from "./slack-context-loader";
import type { SlackConversationInput } from "./slack-event-processor";
import type { SlackMessageRenderer } from "./slack-message-renderer";
import type { MobiusTurnCompletion, SlackReplyDeliveryService } from "./slack-reply-delivery-service";

export class SlackConversationService {
    readonly #storage: SlackEventStorage;
    readonly #platform: SlackPlatformGateway;
    readonly #loader: SlackContextLoader;
    readonly #renderer: SlackMessageRenderer;
    readonly #replies: SlackReplyDeliveryService;
    readonly #connections: ChatBotBindingService;
    readonly #logger: SlackLogger;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly platformProjects: SlackPlatformGateway };
        readonly services: {
            readonly slackContextLoader: SlackContextLoader;
            readonly slackMessageRenderer: SlackMessageRenderer;
            readonly replies: SlackReplyDeliveryService;
            readonly chatBotBindings: ChatBotBindingService;
        };
        readonly logger: SlackLogger;
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { platformProjects } = cx.gateways;
        const {
            slackContextLoader: loader,
            slackMessageRenderer: renderer,
            replies,
            chatBotBindings: connections,
        } = cx.services;
        const { logger } = cx;
        this.#storage = storage;
        this.#platform = platformProjects;
        this.#loader = loader;
        this.#renderer = renderer;
        this.#replies = replies;
        this.#connections = connections;
        this.#logger = logger;
    }
    readonly create = async (
        tenant: TenantContext,
        input: SlackConversationInput,
        signal: AbortSignal,
    ): Promise<"completed" | "queued"> => await this.#start(tenant, input, signal);
    readonly reuse = async (
        tenant: TenantContext,
        input: SlackConversationInput,
        signal: AbortSignal,
    ): Promise<"completed" | "queued"> => await this.#start(tenant, input, signal);

    readonly #start = async (
        tenant: TenantContext,
        input: SlackConversationInput,
        signal: AbortSignal,
    ): Promise<"completed" | "queued"> => {
        this.#logger.info(
            {
                botId: input.botId,
                channelId: input.channelId,
                component: "conversation-service",
                eventId: input.eventId,
                tenantId: input.tenantId,
                threaded: input.threadTs !== null,
            },
            "Starting Slack conversation processing",
        );
        const payload = await this.#storage.findEvent(tenant, input.eventId, input.tenantId, signal);
        if (payload === null) {
            throw new SlackServiceError(
                "SLACK_EVENT_NOT_FOUND",
                "The original event is required to process this conversation",
            );
        }
        const target = await this.#storage.findTargetForPayload(tenant, payload, signal);
        if (target === null || target.tenantId !== input.tenantId || target.botId !== input.botId) {
            this.#logger.warn(
                { component: "conversation-service", eventId: input.eventId, reason: "TARGET_CHANGED" },
                "Slack conversation processing stopped",
            );
            return "completed";
        }
        const key = JSON.stringify([
            input.tenantId,
            target.slackAppRecordId,
            target.slackTeamId,
            input.channelId,
            input.threadTs,
        ]);
        const owner = crypto.randomUUID();
        if (!(await this.#storage.acquireConversation(tenant, key, owner, signal))) {
            const session = await this.#storage.findConversation(tenant, input, signal);
            if (session === null) {
                throw new SlackServiceError(
                    "CONVERSATION_BUSY",
                    "Conversation creation is already in progress; retry this event",
                );
            }
            await this.#storage.queuePending(tenant, input, session.id, Date.now(), signal);
            this.#logger.info(
                {
                    component: "conversation-service",
                    eventId: input.eventId,
                    conversationMappingId: session.id,
                },
                "Slack event queued behind active conversation",
            );
            return "queued";
        }
        try {
            const binding = await this.#connections.resolveBinding(tenant, input.tenantId, input.botId, signal);
            let session = await this.#storage.findConversation(tenant, input, signal, binding.connectionId);
            if (
                session?.latestEventTs !== null &&
                session?.latestEventTs !== undefined &&
                Number(input.eventTs) <= Number(session.latestEventTs)
            ) {
                await this.#storage.resumePendingMessages(tenant, input.tenantId, session.id, signal);
                return "completed";
            }
            const conversationId = await slackSessionId(binding.botId, key);
            await this.#platform.openAutomatedChatSession(
                binding.projectId,
                binding,
                conversationId,
                "Slack conversation",
                signal,
            );
            const clientMessageId = input.eventId;
            const loaded = await this.#loader.load(
                tenant,
                {
                    channelId: input.channelId,
                    currentTs: input.eventTs,
                    loadType: input.contextLoadType,
                    oldest: session?.latestEventTs ?? null,
                    threadTs: payload.event.thread_ts ?? null,
                    token: target.botToken,
                    target,
                },
                signal,
            );
            const attachments = await this.#renderer.renderFiles(tenant, target, input.files, signal);
            session = await this.#storage.prepareMessageDelivery(
                tenant,
                {
                    conversation: input,
                    conversationId,
                    connectionId: binding.connectionId,
                    clientMessageId,
                    slackAppRecordId: target.slackAppRecordId,
                    slackTeamId: target.slackTeamId,
                    latestEventTs:
                        Number(loaded.latestTs ?? "0") > Number(input.eventTs)
                            ? (loaded.latestTs ?? input.eventTs)
                            : input.eventTs,
                },
                signal,
            );
            this.#logger.info(
                {
                    botId: binding.botId,
                    clientMessageId,
                    component: "conversation-service",
                    eventId: input.eventId,
                    conversationId,
                    conversationMappingId: session.id,
                    tenantId: input.tenantId,
                },
                "Chat Bot Session turn prepared",
            );
            try {
                const completion = await this.#execute(
                    binding,
                    clientMessageId,
                    conversationId,
                    [loaded.contextText, input.text, attachments].filter(Boolean).join("\n\n"),
                    signal,
                );
                await this.#replies.deliver(tenant, input.tenantId, completion, signal);
            } finally {
                const cleanup = AbortSignal.timeout(10_000);
                await this.#storage.completeMessageDelivery(tenant, input.tenantId, clientMessageId, cleanup);
                await this.#storage.resumePendingMessages(tenant, input.tenantId, session.id, cleanup);
            }
        } finally {
            await this.#storage.releaseConversation(tenant, key, owner, AbortSignal.timeout(10_000));
        }
        return "completed";
    };

    readonly #execute = async (
        binding: ChatBotBinding,
        clientMessageId: string,
        conversationId: string,
        prompt: string,
        signal: AbortSignal,
    ): Promise<MobiusTurnCompletion> => {
        try {
            const result = await withDeadline(
                signal,
                600_000,
                async (deadline) =>
                    await this.#platform.submitAutomatedChatTurn(
                        binding.projectId,
                        conversationId,
                        {
                            commandId: clientMessageId,
                            prompt,
                            instructions: binding.instructions,
                        },
                        deadline,
                    ),
            );
            this.#logger.info(
                {
                    clientMessageId,
                    component: "conversation-service",
                    responseLength: result.text.length,
                    conversationId,
                    stopReason: result.stopReason,
                },
                "Chat Bot Session turn completed",
            );
            return { kind: "completed", clientMessageId, text: result.text };
        } catch (error) {
            signal.throwIfAborted();
            this.#logger.error(
                { clientMessageId, component: "conversation-service", err: error, conversationId },
                "Chat Bot Session turn failed",
            );
            return {
                kind: "failed",
                clientMessageId,
                code:
                    error instanceof SlackServiceError
                        ? error.code
                        : error instanceof DOMException && error.name === "TimeoutError"
                          ? "MOBIUS_PROMPT_TIMEOUT"
                          : error instanceof TypeError
                            ? "MOBIUS_CONNECTION_FAILED"
                            : "MOBIUS_PROMPT_FAILED",
            };
        }
    };
}

async function slackSessionId(botId: string, conversationKey: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${botId}\u0000${conversationKey}`));
    return `slack_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function withDeadline<T>(
    parent: AbortSignal,
    milliseconds: number,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    parent.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(parent.reason);
    parent.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
        () => controller.abort(new DOMException("The Slack Bot Turn timed out", "TimeoutError")),
        milliseconds,
    );
    try {
        return await operation(controller.signal);
    } finally {
        clearTimeout(timeout);
        parent.removeEventListener("abort", cancel);
    }
}
