import * as v from "valibot";
import { CloudMobiusFetchGateway } from "../../../gateway/cloud-mobius-fetch-gateway.ts";
import { CloudSlackHumanIdentity } from "../../../gateway/cloud-slack-human-identity.ts";
import { IdentityGateway, MobiusGateway, SlackWebApi } from "../../../gateway/index.ts";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { json } from "../../../infra/http.ts";
import { SlackQueueController } from "../controller/slack-queue-controller.ts";
import {
    ClockService,
    createSlackApplication,
    createSlackDependencies,
    createSlackFileHandler,
    createSlackWorker,
    DatabaseSlackAppDirectory,
} from "../index.ts";
import type { BotTriggerRateLimiter } from "../infra/bot-trigger-rate-limiter.ts";
import { CloudflareBotTriggerLimiter } from "../infra/cloudflare-bot-trigger-limiter.ts";
import { CloudflareSlackQueue } from "../infra/cloudflare-slack-queue.ts";
import { slackLogger } from "../infra/logger.ts";
import type { SlackQueueMessage } from "../infra/queue-message.ts";
import { SecretCipher } from "../infra/secret-cipher.ts";
import { D1SqlDatabase } from "../storage/d1-database.ts";
import {
    CloudAttachmentStorageResolver,
    CloudDatabaseResolver,
    configuredDatabase,
} from "../storage/slack-storage-resolvers.ts";

const slackBindingsSchema = v.object({
    ATTACHMENTS: v.object({ get: v.function(), put: v.function() }),
    DATABASE: v.object({ batch: v.function(), prepare: v.function() }),
    BOT_TRIGGER_RATE_LIMITER: v.object({ get: v.function(), idFromName: v.function() }),
    ASSETS: v.object({ fetch: v.function() }),
    AUTHENTICATION_BASE_URL: v.pipe(v.string(), v.url()),
    CLERK_JWT_KEY: v.string(),
    CLERK_PUBLISHABLE_KEY: v.string(),
    EVENTS: v.object({ send: v.function() }),
    MOBIUS_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_MOBIUS_AUTH_TOKEN: v.pipe(v.string(), v.minLength(1)),
    SLACK_OAUTH_STATE_SIGNING_KEY: v.pipe(v.string(), v.minLength(1)),
    SLACK_SERVER_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_TOKEN_ENCRYPTION_KEY: v.pipe(v.string(), v.minLength(1)),
});
interface SlackBindings {
    readonly ATTACHMENTS: R2Bucket;
    readonly DATABASE: D1Database;
    readonly BOT_TRIGGER_RATE_LIMITER: DurableObjectNamespace<BotTriggerRateLimiter>;
    readonly ASSETS: Fetcher;
    readonly EVENTS: Queue<SlackQueueMessage>;
    readonly AUTHENTICATION_BASE_URL: string;
    readonly CLERK_JWT_KEY: string;
    readonly CLERK_PUBLISHABLE_KEY: string;
    readonly MOBIUS_BASE_URL: string;
    readonly SLACK_MOBIUS_AUTH_TOKEN: string;
    readonly SLACK_OAUTH_STATE_SIGNING_KEY: string;
    readonly SLACK_SERVER_BASE_URL: string;
    readonly SLACK_TOKEN_ENCRYPTION_KEY: string;
}
function hasSlackBindings(bindings: CloudBindings): bindings is CloudBindings & SlackBindings {
    return v.safeParse(slackBindingsSchema, bindings).success;
}

const application = createSlackApplication();
const slack = createSlackWorker<
    CloudBindings & SlackBindings,
    ExecutionContext | undefined,
    MessageBatch<SlackQueueMessage>
>((bindings) => {
    const host = { config: { bindings } };
    const database = configuredDatabase(bindings);
    if (database === null) {
        throw new Error("Slack database is unavailable.");
    }
    const cipher = new SecretCipher(bindings.SLACK_TOKEN_ENCRYPTION_KEY);
    const config = {
        bindings,
        authenticationBaseUrl: bindings.AUTHENTICATION_BASE_URL,
        publicBaseUrl: bindings.SLACK_SERVER_BASE_URL.replace(/\/$/u, ""),
        mobiusBaseUrl: bindings.MOBIUS_BASE_URL,
        serviceToken: bindings.SLACK_MOBIUS_AUTH_TOKEN,
        signingKey: bindings.SLACK_OAUTH_STATE_SIGNING_KEY,
    };
    const gateways = {
        clock: new ClockService(),
        createNonce: () => crypto.randomUUID(),
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
        queue: new CloudflareSlackQueue(bindings.EVENTS),
        databaseResolver: new CloudDatabaseResolver(host),
        attachmentStorageResolver: new CloudAttachmentStorageResolver(host),
        slackWebApi: new SlackWebApi(),
        botTriggerLimiter: new CloudflareBotTriggerLimiter(bindings.BOT_TRIGGER_RATE_LIMITER),
        mobiusFetchGateway: new CloudMobiusFetchGateway({ config }),
        slackAppDatabase: new D1SqlDatabase(database),
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            humanIdentity: new CloudSlackHumanIdentity(host),
            mobius: new MobiusGateway(infrastructure),
            identityGateway: new IdentityGateway(infrastructure),
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    return {
        fetchApi: async (request, _environment, context) => await application.fetch(request, cx, context),
        fetchFile: createSlackFileHandler(cx.services.slackFiles),
        consumeQueue: new SlackQueueController(cx.services.queueConsumer, cx.logger).consume,
    };
});

export const slackApplication = {
    fetch: async (request: Request, bindings: CloudBindings, context?: ExecutionContext) => {
        if (!hasSlackBindings(bindings)) {
            return json(
                { error: { code: "SLACK_UNAVAILABLE", message: "Slack integration is temporarily unavailable." } },
                503,
            );
        }
        return await slack.fetch(request, bindings, context);
    },
    queue: async (batch, bindings) => {
        if (!hasSlackBindings(bindings)) {
            throw new Error("Slack queue configuration is unavailable.");
        }
        await slack.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
