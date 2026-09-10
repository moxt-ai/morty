import { type MobiusBinding, type MobiusGateway, MobiusGatewayError } from "../../../../gateway/mobius-gateway";
import type { SlackLogger } from "../../infra/util/logger";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { TenantContext } from "../identity/tenant-context";
import type { MobiusConnectionService } from "../installation/mobius-connection-service";
import type { SlackContextLoader } from "./slack-context-loader";
import type { SlackConversationInput } from "./slack-event-processor";
import type { SlackMessageRenderer } from "./slack-message-renderer";
import type { MobiusTurnCompletion, SlackReplyDeliveryService } from "./slack-reply-delivery-service";

export class SlackConversationService {
    readonly #storage: SlackEventStorage;
    readonly #mobius: MobiusGateway;
    readonly #loader: SlackContextLoader;
    readonly #renderer: SlackMessageRenderer;
    readonly #replies: SlackReplyDeliveryService;
    readonly #connections: MobiusConnectionService;
    readonly #logger: SlackLogger;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly mobius: MobiusGateway };
        readonly services: {
            readonly slackContextLoader: SlackContextLoader;
            readonly slackMessageRenderer: SlackMessageRenderer;
            readonly replies: SlackReplyDeliveryService;
            readonly mobiusConnections: MobiusConnectionService;
        };
        readonly logger: SlackLogger;
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { mobius } = cx.gateways;
        const {
            slackContextLoader: loader,
            slackMessageRenderer: renderer,
            replies,
            mobiusConnections: connections,
        } = cx.services;
        const { logger } = cx;
        this.#storage = storage;
        this.#mobius = mobius;
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
            throw new MobiusGatewayError(
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
                throw new MobiusGatewayError(
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
            const conversationId =
                session?.conversationId ??
                (await this.#mobius.createConversation(binding, crypto.randomUUID(), signal));
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
                "Mobius command prepared",
            );
            try {
                const completion = await this.#execute(
                    binding,
                    clientMessageId,
                    conversationId,
                    [loaded.contextText, input.text, attachments].filter(Boolean).join("\n\n"),
                    `slack:${target.slackTeamId}:${input.sender.kind === "user" ? input.sender.slackUserId : input.sender.slackBotId}`,
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
        binding: MobiusBinding,
        clientMessageId: string,
        conversationId: string,
        prompt: string,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<MobiusTurnCompletion> => {
        try {
            const result = await this.#mobius.prompt(
                {
                    binding,
                    clientMessageId,
                    conversationId,
                    prompt,
                    actorRef,
                },
                signal,
            );
            this.#logger.info(
                {
                    clientMessageId,
                    component: "conversation-service",
                    responseLength: result.text.length,
                    conversationId,
                    stopReason: result.stopReason,
                },
                "Mobius command completed",
            );
            return { kind: "completed", clientMessageId, text: result.text };
        } catch (error) {
            signal.throwIfAborted();
            this.#logger.error(
                { clientMessageId, component: "conversation-service", err: error, conversationId },
                "Mobius command failed",
            );
            return {
                kind: "failed",
                clientMessageId,
                code:
                    error instanceof MobiusGatewayError
                        ? error.code
                        : error instanceof DOMException && error.name === "TimeoutError"
                          ? "MOBIUS_PROMPT_TIMEOUT"
                          : "MOBIUS_PROMPT_FAILED",
            };
        }
    };
}
