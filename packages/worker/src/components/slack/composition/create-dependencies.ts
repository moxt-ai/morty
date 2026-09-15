import { SlackContextLoader } from "../service/bot-run/slack-context-loader";
import { SlackConversationService } from "../service/bot-run/slack-conversation-service";
import { SlackEventContextService } from "../service/bot-run/slack-event-context-service";
import { SlackEventProcessor } from "../service/bot-run/slack-event-processor";
import { SlackMessageRenderer } from "../service/bot-run/slack-message-renderer";
import { SlackQueueConsumer } from "../service/bot-run/slack-queue-consumer";
import { SlackReplyDeliveryService } from "../service/bot-run/slack-reply-delivery-service";
import { TenantQueueConsumer } from "../service/bot-run/tenant-queue-consumer";
import { SlackFileService } from "../service/bot-tools/slack-file-service";
import { SlackEventIntakeService } from "../service/events/slack-event-intake-service";
import { SlackEventsService } from "../service/events/slack-events-service";
import { ExternalIdentityService } from "../service/identity/external-identity-service";
import { SlackTokenService } from "../service/identity/slack-token-service";
import { MobiusConnectionService } from "../service/installation/mobius-connection-service";
import { SlackInstallationService } from "../service/installation/slack-installation-service";
import { SlackManagementService } from "../service/installation/slack-management-service";
import { MobiusConnectionStorage, SlackEventStorage } from "../storage/index";
import type { SlackInfrastructure } from "./slack-infrastructure";
export type SlackContext = ReturnType<typeof createSlackDependencies>;

export function createSlackDependencies(infrastructure: SlackInfrastructure) {
    const storages = Object.freeze({
        mobiusConnectionStorage: new MobiusConnectionStorage(infrastructure),
        slackEventStorage: new SlackEventStorage(infrastructure),
    });
    const cx = { ...infrastructure, storages };
    const slackTokens = new SlackTokenService(cx);
    const identities = new ExternalIdentityService(cx);
    const intake = new SlackEventIntakeService(cx);
    const mobiusConnections = new MobiusConnectionService(cx);
    const installations = new SlackInstallationService({ ...cx, services: { identities, slackTokens } });
    const management = new SlackManagementService({ ...cx, services: { mobiusConnections } });
    const replies = new SlackReplyDeliveryService(cx);
    const slackMessageRenderer = new SlackMessageRenderer(cx);
    const slackFiles = new SlackFileService(cx);
    const slackContextLoader = new SlackContextLoader({ ...cx, services: { slackMessageRenderer } });
    const slackConversations = new SlackConversationService({
        ...cx,
        services: { slackContextLoader, slackMessageRenderer, replies, mobiusConnections },
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
        mobiusConnections,
        installations,
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
