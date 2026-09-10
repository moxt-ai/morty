import * as v from "valibot";
import { ClerkGateway } from "../../gateway/clerk-gateway.ts";
import { IdentityGateway } from "../../gateway/identity-gateway.ts";
import { FetchMobiusTransport, MobiusGateway } from "../../gateway/mobius-gateway.ts";
import { SlackWebApi } from "../../gateway/slack-web-gateway.ts";
import type { CloudBindings } from "../../infra/cloud-bindings.ts";
import { json } from "../../infra/http.ts";
import { IdentityStorage } from "../management/storage/identity-storage.ts";
import type { BotTriggerRateLimiter } from "./do/bot-trigger-rate-limiter.ts";
import { CloudflareBotTriggerLimiter } from "./do/cloudflare-bot-trigger-limiter.ts";
import {
    ClockService,
    createSlackApplication,
    createSlackDependencies,
    createSlackFileHandler,
    createSlackWorker,
    DatabaseSlackAppDirectory,
} from "./index.ts";
import { CloudflareSlackQueue } from "./infra/cloudflare-slack-queue.ts";
import type { SlackQueueMessage } from "./infra/queue-message.ts";
import { slackLogger } from "./infra/util/logger.ts";
import { SecretCipher } from "./infra/util/secret-cipher.ts";
import { SlackQueueHandler } from "./queue/slack-queue-handler.ts";
import { D1SqlDatabase } from "./storage/d1-database.ts";
import {
    CloudAttachmentStorageResolver,
    CloudDatabaseResolver,
    configuredDatabase,
} from "./storage/slack-storage-resolvers.ts";

const slackBindingsSchema = v.object({
    ATTACHMENTS: v.object({ get: v.function(), put: v.function() }),
    DATABASE: v.object({ batch: v.function(), prepare: v.function() }),
    BOT_TRIGGER_RATE_LIMITER: v.object({ get: v.function(), idFromName: v.function() }),
    ASSETS: v.object({ fetch: v.function() }),
    APP_ORIGIN: v.pipe(v.string(), v.url()),
    AUTHENTICATION_BASE_URL: v.pipe(v.string(), v.url()),
    CLERK_JWT_KEY: v.string(),
    CLERK_PUBLISHABLE_KEY: v.string(),
    EVENTS: v.object({ send: v.function() }),
    MOBIUS_APP_ID: v.pipe(v.string(), v.minLength(1)),
    MOBIUS_APP_SECRET: v.pipe(v.string(), v.minLength(1)),
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
    readonly APP_ORIGIN: string;
    readonly EVENTS: Queue<SlackQueueMessage>;
    readonly AUTHENTICATION_BASE_URL: string;
    readonly CLERK_JWT_KEY: string;
    readonly CLERK_PUBLISHABLE_KEY: string;
    readonly MOBIUS_APP_ID: string;
    readonly MOBIUS_APP_SECRET: string;
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
    const identities = new IdentityStorage(bindings.DATABASE);
    const config = {
        bindings,
        authentication: {
            APP_ORIGIN: bindings.APP_ORIGIN,
            CLERK_JWT_KEY: bindings.CLERK_JWT_KEY,
            CLERK_PUBLISHABLE_KEY: bindings.CLERK_PUBLISHABLE_KEY,
        },
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
        clerk: new ClerkGateway(),
        slackWebApi: new SlackWebApi(),
        botTriggerLimiter: new CloudflareBotTriggerLimiter(bindings.BOT_TRIGGER_RATE_LIMITER),
        mobiusTransport: new FetchMobiusTransport({
            appId: bindings.MOBIUS_APP_ID,
            appSecret: bindings.MOBIUS_APP_SECRET,
            baseUrl: bindings.MOBIUS_BASE_URL,
            forbiddenOrigin: bindings.APP_ORIGIN,
        }),
        slackAppDatabase: new D1SqlDatabase(database),
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            mobius: new MobiusGateway(infrastructure),
            identityGateway: new IdentityGateway(infrastructure),
            humanIdentity: {
                resolve: (clerkUserId: string, signal: AbortSignal) =>
                    identities.resolveOrCreateClerk(clerkUserId, Date.now(), signal),
            },
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    return {
        fetchApi: async (request, _environment, context) => await application.fetch(request, cx, context),
        fetchFile: createSlackFileHandler(cx.services.slackFiles),
        consumeQueue: new SlackQueueHandler(cx.services.queueConsumer, cx.logger).consume,
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
