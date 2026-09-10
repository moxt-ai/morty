import {
    ClockService,
    DatabaseSlackAppDirectory,
    type SlackInfrastructure,
    StandaloneTenantShardingDirectory,
    TenantStorageError,
} from "@moxt-ai/app-slack-api";
import { IdentityGateway, MobiusGateway, SlackWebApi } from "@moxt-ai/app-slack-api/gateway";
import { MobiusFetchGateway, SecretCipher, slackLogger } from "@moxt-ai/app-slack-api/infra";
import { StandaloneHumanIdentity } from "../gateway/standalone-human-identity";
import { createCloudflareEnvironment, type WorkerBindings } from "./create-cloudflare-environment";

export function createCloudflareInfrastructure(
    bindings: WorkerBindings,
    mobiusFetch?: MobiusFetchGateway,
): SlackInfrastructure {
    const environment = createCloudflareEnvironment(bindings);
    const cipher = new SecretCipher(environment.SLACK_TOKEN_ENCRYPTION_KEY);
    const clock = new ClockService();
    const tenants = new StandaloneTenantShardingDirectory();
    const databases: SlackInfrastructure["gateways"]["databaseResolver"] = {
        resolve: (sharding) => {
            if (sharding.hasShard) {
                throw new TenantStorageError();
            }
            return environment.database;
        },
    };
    const attachments: SlackInfrastructure["gateways"]["attachmentStorageResolver"] = {
        resolve: (sharding) => {
            if (sharding.hasShard) {
                throw new TenantStorageError();
            }
            return environment.attachments;
        },
    };
    const config = {
        publicBaseUrl: environment.SLACK_SERVER_BASE_URL.replace(/\/$/u, ""),
        mobiusBaseUrl: environment.MOBIUS_BASE_URL,
        signingKey: environment.SLACK_OAUTH_STATE_SIGNING_KEY,
        serviceToken: environment.SLACK_MOBIUS_AUTH_TOKEN,
    };
    const gateways = {
        clock,
        createNonce: () => crypto.randomUUID(),
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
        queue: environment.queue,
        databaseResolver: databases,
        attachmentStorageResolver: attachments,
        tenantShardingDirectory: tenants,
        slackAppDatabases: [{ database: environment.database, shardIds: [null] }],
        mobiusFetchGateway: mobiusFetch ?? new MobiusFetchGateway({ config }),
        slackWebApi: new SlackWebApi(),
        botTriggerLimiter: environment.botTriggerLimiter,
    };
    const cx = { config, gateways, logger: slackLogger };
    return {
        config,
        logger: cx.logger,
        gateways: {
            ...gateways,
            slackAppDirectory: new DatabaseSlackAppDirectory(cx),
            humanIdentity: new StandaloneHumanIdentity(),
            mobius: new MobiusGateway(cx),
            identityGateway: new IdentityGateway(cx),
        },
    };
}
