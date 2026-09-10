import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import type { BotTriggerRateLimiter } from "../infra/bot-trigger-rate-limiter";
import { CloudflareBotTriggerLimiter } from "../infra/cloudflare-bot-trigger-limiter";
import { CloudflareSlackQueue } from "../infra/cloudflare-slack-queue";
import { D1SqlDatabase } from "../storage/d1-database";
import { R2SlackAttachmentStorage } from "../storage/r2-slack-attachment-storage";

export interface WorkerBindings {
    readonly BOT_TRIGGER_RATE_LIMITER: DurableObjectNamespace<BotTriggerRateLimiter>;
    readonly ASSETS: Fetcher;
    readonly ATTACHMENTS: R2Bucket;
    readonly DATABASE: D1Database;
    readonly EVENTS: Queue<SlackQueueMessage>;
    readonly MOBIUS_BASE_URL: string;
    readonly SLACK_OAUTH_STATE_SIGNING_KEY: string;
    readonly SLACK_SERVER_BASE_URL: string;
    readonly SLACK_MOBIUS_AUTH_TOKEN: string;
    readonly SLACK_TOKEN_ENCRYPTION_KEY: string;
}

export function createCloudflareEnvironment(bindings: WorkerBindings) {
    return {
        botTriggerLimiter: new CloudflareBotTriggerLimiter(bindings.BOT_TRIGGER_RATE_LIMITER),
        attachments: new R2SlackAttachmentStorage(bindings.ATTACHMENTS),
        database: new D1SqlDatabase(bindings.DATABASE),
        queue: new CloudflareSlackQueue(bindings.EVENTS),
        MOBIUS_BASE_URL: bindings.MOBIUS_BASE_URL,
        SLACK_OAUTH_STATE_SIGNING_KEY: bindings.SLACK_OAUTH_STATE_SIGNING_KEY,
        SLACK_SERVER_BASE_URL: bindings.SLACK_SERVER_BASE_URL,
        SLACK_MOBIUS_AUTH_TOKEN: bindings.SLACK_MOBIUS_AUTH_TOKEN,
        SLACK_TOKEN_ENCRYPTION_KEY: bindings.SLACK_TOKEN_ENCRYPTION_KEY,
    };
}
