import type { BotTriggerLimiter } from "../../gateway/bot-trigger-limiter";
import type { SlackLogger } from "../../infra/logger";
import type { SlackMessageFile } from "../bot-tools/slack-bot-tool-service";
import type { SlackEventCallbackPayload } from "../events/events";
import type { TenantContext } from "../identity/tenant-context";
import { type ContextLoadType, type DecisionInput, decideSlackEvent, type Sender } from "./event-decision";
import type { SlackConversationService } from "./slack-conversation-service";
import type { SlackEventContextService } from "./slack-event-context-service";

export interface SlackEventTargetContext {
    readonly botId: string;
    readonly botUserId: string;
    readonly sender: Sender;
    readonly tenantId: string;
}

export interface SlackConversationKey {
    readonly botId: string;
    readonly channelId: string;
    readonly tenantId: string;
    readonly threadTs: string | null;
}

export interface SlackConversationInput extends SlackConversationKey {
    readonly contextLoadType: ContextLoadType;
    readonly eventId: string;
    readonly eventTs: string;
    readonly files: readonly SlackMessageFile[];
    readonly sender: Sender;
    readonly text: string;
}

export type SlackEventProcessingResult =
    | { readonly kind: "conversation-queued" }
    | { readonly kind: "conversation-created" }
    | { readonly kind: "conversation-reused" }
    | {
          readonly kind: "ignored";
          readonly reason:
              | "EVENT_NOT_ACTIONABLE"
              | "BOT_TRIGGER_LIMIT_REACHED"
              | "TARGET_NOT_FOUND"
              | "ROUTING_DECISION_SKIPPED";
      };

export class SlackEventProcessor {
    readonly #botTriggerLimiter: BotTriggerLimiter;
    readonly #conversations: SlackConversationService;
    readonly #sessions: SlackEventContextService;
    readonly #logger: SlackLogger;
    constructor(cx: {
        readonly gateways: { readonly botTriggerLimiter: BotTriggerLimiter };
        readonly services: {
            readonly slackConversations: SlackConversationService;
            readonly slackEventContext: SlackEventContextService;
        };
        readonly logger: SlackLogger;
    }) {
        const { botTriggerLimiter } = cx.gateways;
        const { slackConversations: conversations, slackEventContext: sessions } = cx.services;
        const { logger } = cx;
        this.#botTriggerLimiter = botTriggerLimiter;
        this.#conversations = conversations;
        this.#sessions = sessions;
        this.#logger = logger;
    }

    readonly process = async (
        tenant: TenantContext,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<SlackEventProcessingResult> => {
        const event = payload.event;
        if (
            (event.type !== "message" && event.type !== "app_mention") ||
            event.channel == null ||
            event.channel_type == null ||
            event.ts == null
        ) {
            this.#logger.info(
                {
                    component: "event-processor",
                    eventId: payload.event_id,
                    eventType: event.type,
                    reason: "EVENT_NOT_ACTIONABLE",
                },
                "Slack event ignored",
            );
            return { kind: "ignored", reason: "EVENT_NOT_ACTIONABLE" };
        }

        const context = await this.#sessions.resolve(tenant, payload, signal);
        if (context === null) {
            this.#logger.warn(
                { component: "event-processor", eventId: payload.event_id, reason: "TARGET_NOT_FOUND" },
                "Slack event ignored",
            );
            return { kind: "ignored", reason: "TARGET_NOT_FOUND" };
        }

        const threadTs = event.thread_ts ?? null;
        const key: SlackConversationKey = {
            botId: context.botId,
            channelId: event.channel,
            tenantId: context.tenantId,
            threadTs: event.channel_type === "im" ? threadTs : (threadTs ?? event.ts),
        };
        const sessionExists = await this.#sessions.exists(tenant, key, signal);
        const location = resolveLocation(event.channel_type, threadTs);
        const mentionType = resolveMentionType(event.text ?? "", context.botUserId);
        const botInitiatedThread: DecisionInput["botInitiatedThread"] =
            location === "CHANNEL_THREAD" && !sessionExists
                ? {
                      initiatedByTarget: await this.#sessions.isBotInitiatedThread(tenant, key, signal),
                      kind: "checked",
                  }
                : { kind: "not-checked" };
        const decision = decideSlackEvent({
            botInitiatedThread,
            command: resolveCommand(event.text ?? "", context.botUserId),
            location,
            mentionType,
            sender: context.sender,
            sessionState: sessionExists ? "HAS_SESSION" : "NO_SESSION",
        });
        this.#logger.info(
            {
                action: decision.action,
                botId: context.botId,
                channelId: event.channel,
                component: "event-processor",
                eventId: payload.event_id,
                location,
                senderKind: context.sender.kind,
                sessionExists,
                tenantId: context.tenantId,
            },
            "Slack routing decision resolved",
        );

        if (
            context.sender.kind === "bot" &&
            decision.action !== "SKIP" &&
            !(await this.#admitBotTrigger(key, signal))
        ) {
            this.#logger.warn(
                {
                    botId: context.botId,
                    component: "event-processor",
                    eventId: payload.event_id,
                    reason: "BOT_TRIGGER_LIMIT_REACHED",
                    tenantId: context.tenantId,
                },
                "Slack event ignored",
            );
            return {
                kind: "ignored",
                reason: "BOT_TRIGGER_LIMIT_REACHED",
            };
        }

        switch (decision.action) {
            case "CREATE_SESSION":
            case "CREATE_SESSION_BY_BOT": {
                const result = await this.#conversations.create(
                    tenant,
                    conversationInput(
                        key,
                        context.sender,
                        decision.contextLoadType,
                        payload.event_id,
                        event.ts,
                        event.text ?? "",
                        eventFiles(event.files ?? []),
                    ),
                    signal,
                );
                return { kind: result === "queued" ? "conversation-queued" : "conversation-created" };
            }
            case "REUSE_SESSION": {
                const result = await this.#conversations.reuse(
                    tenant,
                    conversationInput(
                        key,
                        context.sender,
                        decision.contextLoadType,
                        payload.event_id,
                        event.ts,
                        event.text ?? "",
                        eventFiles(event.files ?? []),
                    ),
                    signal,
                );
                return { kind: result === "queued" ? "conversation-queued" : "conversation-reused" };
            }
            case "SKIP":
                return { kind: "ignored", reason: "ROUTING_DECISION_SKIPPED" };
        }
    };

    readonly #admitBotTrigger = async (key: SlackConversationKey, signal: AbortSignal): Promise<boolean> => {
        try {
            return await this.#botTriggerLimiter.admit(key, signal);
        } catch {
            signal.throwIfAborted();
            return true;
        }
    };
}

function conversationInput(
    key: SlackConversationKey,
    sender: Sender,
    contextLoadType: ContextLoadType,
    eventId: string,
    eventTs: string,
    text: string,
    files: readonly SlackMessageFile[],
): SlackConversationInput {
    return {
        ...key,
        contextLoadType,
        eventId,
        eventTs,
        files,
        sender,
        text,
    };
}

function eventFiles(
    files: readonly {
        readonly id: string;
        readonly mimetype?: string | null | undefined;
        readonly name?: string | null | undefined;
        readonly size?: number | null | undefined;
        readonly url_private?: string | null | undefined;
    }[],
): readonly SlackMessageFile[] {
    return files.map((file) => ({
        id: file.id,
        mimetype: file.mimetype ?? null,
        name: file.name ?? null,
        size: file.size ?? null,
        urlPrivate: file.url_private ?? null,
    }));
}

function resolveLocation(
    channelType: string,
    threadTs: string | null,
): "CHANNEL_THREAD" | "CHANNEL_TOP" | "DM_THREAD" | "DM_TOP" {
    if (channelType === "im") {
        return threadTs === null ? "DM_TOP" : "DM_THREAD";
    }
    return threadTs === null ? "CHANNEL_TOP" : "CHANNEL_THREAD";
}

function resolveMentionType(text: string, botUserId: string): "MENTION_OTHER_APP" | "MENTION_THIS_APP" | "NO_MENTION" {
    if (text.includes(`<@${botUserId}>`)) {
        return "MENTION_THIS_APP";
    }
    return /<@[A-Z0-9]+>/u.test(text) ? "MENTION_OTHER_APP" : "NO_MENTION";
}

function resolveCommand(text: string, botUserId: string): "NEW_SESSION" | null {
    const withoutMention = text.replaceAll(`<@${botUserId}>`, "").trim();
    return withoutMention === "new-session" ? "NEW_SESSION" : null;
}
