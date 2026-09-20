import { SlackContextLoader } from "../service/bot-run/slack-context-loader";
import { SlackConversationService } from "../service/bot-run/slack-conversation-service";
import { SlackEventContextService } from "../service/bot-run/slack-event-context-service";
import { SlackEventProcessor } from "../service/bot-run/slack-event-processor";
import { SlackMessageRenderer } from "../service/bot-run/slack-message-renderer";
import { SlackQueueConsumer } from "../service/bot-run/slack-queue-consumer";
import { SlackReplyDeliveryService } from "../service/bot-run/slack-reply-delivery-service";
import { TenantQueueConsumer } from "../service/bot-run/tenant-queue-consumer";
import { SlackBotToolService } from "../service/bot-tools/slack-bot-tool-service";
import { SlackFileService } from "../service/bot-tools/slack-file-service";
import { SlackEventIntakeService } from "../service/events/slack-event-intake-service";
import { SlackEventsService } from "../service/events/slack-events-service";
import { ExternalIdentityService } from "../service/identity/external-identity-service";
import { SlackTokenService } from "../service/identity/slack-token-service";
import { ChatBotBindingService } from "../service/installation/chat-bot-binding-service";
import { SlackInstallationService } from "../service/installation/slack-installation-service";
import { SlackManagementService } from "../service/installation/slack-management-service";
import { ChatBotBindingStorage, SlackEventStorage } from "../storage/index";
import type { SlackInfrastructure } from "./slack-infrastructure";
export type SlackContext = ReturnType<typeof createSlackDependencies>;

export function createSlackDependencies(infrastructure: SlackInfrastructure) {
    const storages = Object.freeze({
        ...infrastructure.storages,
        chatBotBindingStorage: new ChatBotBindingStorage(infrastructure),
        slackEventStorage: new SlackEventStorage(infrastructure),
    });
    const cx = { ...infrastructure, storages };
    const slackTokens = new SlackTokenService(cx);
    const identities = new ExternalIdentityService(cx);
    const intake = new SlackEventIntakeService(cx);
    const chatBotBindings = new ChatBotBindingService(cx);
    const installations = new SlackInstallationService({ ...cx, services: { identities, slackTokens } });
    const botTools = new SlackBotToolService({ ...cx, services: { identities } });
    const management = new SlackManagementService({
        ...cx,
        services: { installations, chatBotBindings, slackTokens },
    });
    const replies = new SlackReplyDeliveryService(cx);
    const slackMessageRenderer = new SlackMessageRenderer(cx);
    const slackFiles = new SlackFileService(cx);
    const slackContextLoader = new SlackContextLoader({ ...cx, services: { slackMessageRenderer } });
    const slackConversations = new SlackConversationService({
        ...cx,
        services: { slackContextLoader, slackMessageRenderer, replies, chatBotBindings },
    });
    const slackEventContext = new SlackEventContextService(cx);
    const eventProcessor = new SlackEventProcessor({
        ...cx,
        services: { slackConversations, slackEventContext },
    });
    const queueProcessor = new SlackQueueConsumer({ ...cx, services: { eventProcessor } });
    const services = Object.freeze({
        slackTokens,
        identities,
        intake,
        chatBotBindings,
        installations,
        botTools,
        management,
        replies,
        slackMessageRenderer,
        slackFiles,
        slackContextLoader,
        slackConversations,
        slackEventContext,
        eventProcessor,
        queueProcessor,
        slackEvents: new SlackEventsService({ ...cx, services: { intake } }),
        queueConsumer: new TenantQueueConsumer({ ...cx, services: { queueProcessor } }),
    });
    return Object.freeze({ ...cx, services });
}
