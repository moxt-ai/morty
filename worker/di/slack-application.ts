import {
    ClockService,
    createSlackApplication,
    createSlackDependencies,
    createSlackFileHandler,
    createSlackWorker,
    DatabaseSlackAppDirectory,
} from "@moxt-ai/app-slack-api";
import { IdentityGateway, MobiusGateway, SlackWebApi } from "@moxt-ai/app-slack-api/gateway";
import { SecretCipher, type SlackQueueMessage, slackLogger } from "@moxt-ai/app-slack-api/infra";
import * as v from "valibot";
import { SlackQueueController } from "../../apps/slack/packages/worker/src/controller/slack-queue-controller.ts";
import type { WorkerBindings } from "../../apps/slack/packages/worker/src/di/create-cloudflare-environment.ts";
import { CloudflareAgentTriggerLimiter } from "../../apps/slack/packages/worker/src/infra/cloudflare-agent-trigger-limiter.ts";
import { CloudflareMobiusTransport } from "../../apps/slack/packages/worker/src/infra/cloudflare-mobius-transport.ts";
import { CloudflareSlackQueue } from "../../apps/slack/packages/worker/src/infra/cloudflare-slack-queue.ts";
import { D1SqlDatabase } from "../../apps/slack/packages/worker/src/storage/d1-database.ts";
import { CloudMobiusFetchGateway } from "../gateway/cloud-mobius-fetch-gateway.ts";
import { CloudSlackHumanIdentity } from "../gateway/cloud-slack-human-identity.ts";
import { CloudTenantShardingDirectory } from "../gateway/cloud-tenant-sharding-directory.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";
import {
    CloudAttachmentStorageResolver,
    CloudDatabaseResolver,
    configuredD1Candidates,
} from "../storage/slack-storage-resolvers.ts";

const slackBindingsSchema = v.object({
    AGENT_TRIGGER_RATE_LIMITER: v.object({
        get: v.function(),
        idFromName: v.function(),
    }),
    ASSETS: v.object({ fetch: v.function() }),
    CLERK_ISSUER_URL: v.pipe(v.string(), v.url()),
    CLERK_JWT_KEY: v.string(),
    EVENTS: v.object({ send: v.function() }),
    MOBIUS_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_MOBIUS_AUTH_TOKEN: v.pipe(v.string(), v.minLength(1)),
    SLACK_OAUTH_STATE_SIGNING_KEY: v.pipe(v.string(), v.minLength(1)),
    SLACK_SERVER_BASE_URL: v.pipe(v.string(), v.url()),
    SLACK_TOKEN_ENCRYPTION_KEY: v.pipe(v.string(), v.minLength(1)),
});

type SlackBindings = Omit<WorkerBindings, "DATABASE" | "ATTACHMENTS"> & {
    readonly CLERK_JWT_KEY: string;
    readonly CLERK_ISSUER_URL: string;
};

function hasSlackBindings(bindings: CloudBindings): bindings is CloudBindings & SlackBindings {
    return v.safeParse(slackBindingsSchema, bindings).success;
}

const application = createSlackApplication();
const slack = createSlackWorker<
    CloudBindings & SlackBindings & { readonly pairingAuthorization: string | null },
    ExecutionContext | undefined,
    MessageBatch<SlackQueueMessage>
>((bindings) => {
    const environment = {
        ...bindings,
        agentTriggerLimiter: new CloudflareAgentTriggerLimiter(bindings.AGENT_TRIGGER_RATE_LIMITER),
        mobiusTransport: new CloudflareMobiusTransport(),
        queue: new CloudflareSlackQueue(bindings.EVENTS),
    };
    const host = { config: { bindings } };
    const tenants = new CloudTenantShardingDirectory(host);
    const shardedDatabases = new CloudDatabaseResolver(host);
    const shardedAttachments = new CloudAttachmentStorageResolver(host);
    const cipher = new SecretCipher(environment.SLACK_TOKEN_ENCRYPTION_KEY);
    const clock = new ClockService();
    const config = {
        bindings,
        clerkJwtKey: environment.CLERK_JWT_KEY,
        clerkIssuerUrl: environment.CLERK_ISSUER_URL,
        clerkAuthorizedParties: [new URL(environment.SLACK_SERVER_BASE_URL).origin],
        publicBaseUrl: environment.SLACK_SERVER_BASE_URL.replace(/\/$/u, ""),
        mobiusBaseUrl: environment.MOBIUS_BASE_URL,
        pairingAuthorization: bindings.pairingAuthorization,
        serviceToken: environment.SLACK_MOBIUS_AUTH_TOKEN,
        signingKey: environment.SLACK_OAUTH_STATE_SIGNING_KEY,
    };
    const gateways = {
        clock,
        createNonce: () => crypto.randomUUID(),
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
        queue: environment.queue,
        tenantShardingDirectory: tenants,
        databaseResolver: shardedDatabases,
        attachmentStorageResolver: shardedAttachments,
        slackWebApi: new SlackWebApi(),
        agentTriggerLimiter: environment.agentTriggerLimiter,
        mobiusTransport: environment.mobiusTransport,
        mobiusFetchGateway: new CloudMobiusFetchGateway({ config }),
        slackAppDatabases: configuredD1Candidates(bindings).map(({ database, shardId }) => ({
            shardIds: [shardId],
            database: new D1SqlDatabase(database),
        })),
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            humanIdentity: new CloudSlackHumanIdentity(infrastructure),
            mobius: new MobiusGateway(infrastructure),
            identityGateway: new IdentityGateway(infrastructure),
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    return {
        fetchApi: async (request, _environment, context) => await application.fetch(request, cx, context),
        fetchFile: createSlackFileHandler(cx.services.slackFiles, cx.gateways.tenantShardingDirectory),
        consumeQueue: new SlackQueueController(cx.services.queueConsumer, cx.logger).consume,
    };
});

export const slackApplication = {
    fetch: async (request: Request, bindings: CloudBindings, context?: ExecutionContext) => {
        if (!hasSlackBindings(bindings)) {
            return json(
                {
                    error: {
                        code: "SLACK_UNAVAILABLE",
                        message: "Slack integration is temporarily unavailable.",
                    },
                },
                503,
            );
        }
        return await slack.fetch(
            request,
            { ...bindings, pairingAuthorization: request.headers.get("Authorization") },
            context,
        );
    },
    queue: async (batch, bindings) => {
        if (!hasSlackBindings(bindings)) {
            throw new Error("Slack queue configuration is unavailable.");
        }
        await slack.queue(batch, { ...bindings, pairingAuthorization: null });
    },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
