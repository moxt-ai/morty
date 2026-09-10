import * as v from "valibot";
import { createSlackApplication } from "../../src/app";
import { createSlackDependencies } from "../../src/create-dependencies";
import { MobiusGateway } from "../../src/gateway/index";
import { createSlackFileHandler } from "../../src/http/bot-tools/slack-file-handler";
import { slackLogger } from "../../src/infra/logger";
import type { SlackQueueMessage } from "../../src/infra/queue-message";
import { SecretCipher } from "../../src/infra/secret-cipher";
import { ClockService } from "../../src/service/identity/clock-service";
import { IdentityError, type TenantSharding } from "../../src/service/identity/identity-service";
import type { TenantContext, TenantShardingDirectory } from "../../src/service/identity/tenant-context";
import type { TenantShardResolution } from "../../src/service/identity/tenant-shard-resolver";
import { DatabaseSlackAppDirectory } from "../../src/storage/database-slack-app-directory";
import { TenantStorageError } from "../../src/storage/tenant-storage-error";
import { InMemoryAttachments } from "./in-memory-attachments";
import { InMemoryHumanIdentity } from "./in-memory-human-identity";
import { InMemoryIdentityGateway } from "./in-memory-identity-gateway";
import { InMemoryMobius } from "./in-memory-mobius-gateway";
import { InMemorySlack } from "./in-memory-slack-gateway";
import { createSignedRequest } from "./signed-request";
import { createTestDatabase } from "./test-database";

class InMemoryTenantShardResolver implements TenantShardingDirectory {
    readonly #assignments = new Map<string, TenantShardResolution>();

    readonly assign = (tenantId: string, sharding: TenantSharding): void => {
        this.#assignments.set(tenantId, { hasShard: true, shard: sharding });
    };

    readonly use = (sharding: TenantSharding): void => {
        this.assign("tenant-1", sharding);
    };

    readonly resolve = async (tenantId: string, signal: AbortSignal): Promise<TenantContext> => {
        signal.throwIfAborted();
        return { tenantId, tenantSharding: this.#assignments.get(tenantId) ?? { hasShard: false } };
    };
    readonly fromClaims = async (tenantId: string, value: unknown, signal: AbortSignal): Promise<TenantContext> => {
        const tenant = await this.resolve(tenantId, signal);
        if (tenant.tenantSharding.hasShard) {
            const shard = tenant.tenantSharding.shard;
            const parsed = v.safeParse(
                v.object({
                    mobius_d1_shard_id: v.literal(shard.d1ShardId),
                    mobius_r2_bucket_id: v.literal(shard.r2BucketId),
                    mobius_placement_revision: v.literal(shard.revision),
                }),
                value,
            );
            if (!parsed.success) {
                throw new IdentityError("AUTHENTICATION_FAILED", "Tenant placement is not configured");
            }
        }
        return tenant;
    };
}

export async function createTestApplication(
    sharded = false,
    createMobiusGateway: (cx: ConstructorParameters<typeof MobiusGateway>[0]) => MobiusGateway = (cx) =>
        new MobiusGateway(cx),
) {
    const database = createTestDatabase();
    const legacyDatabase = sharded ? createTestDatabase() : database;
    const cipher = new SecretCipher(btoa("a".repeat(32)));
    const slack = new InMemorySlack();
    const mobius = new InMemoryMobius();
    const identity = new InMemoryIdentityGateway();
    const tenantShards = new InMemoryTenantShardResolver();
    const attachments = new InMemoryAttachments();
    const placement = { d1ShardId: "apac-02", r2BucketId: "apac", revision: 1 };
    if (sharded) {
        tenantShards.use(placement);
    }
    const pending: SlackQueueMessage[] = [];
    const humanIdentity = new InMemoryHumanIdentity(tenantShards);
    const { humanToken } = humanIdentity;
    const limiter = {
        mode: "admit",
        admit: async (): Promise<boolean> => {
            if (limiter.mode === "fail") {
                throw new Error("Unavailable");
            }
            return limiter.mode === "admit";
        },
    };
    const queue = {
        send: async (message: SlackQueueMessage): Promise<void> => {
            pending.push(message);
        },
    };
    const config = {
        publicBaseUrl: "https://slack.example.test",
        mobiusBaseUrl: "https://mobius.test",
        signingKey: "state-signing-key",
    };
    const gateways = {
        clock: new ClockService(),
        createNonce: () => "nonce-1",
        nowEpochMilliseconds: () => Date.now(),
        secretEncryption: cipher,
        queue,
        tenantShardingDirectory: tenantShards,
        databaseResolver: {
            resolve: (resolution: TenantShardResolution) => {
                if (!resolution.hasShard) {
                    return legacyDatabase;
                }
                if (!sharded || resolution.shard.d1ShardId !== placement.d1ShardId) {
                    throw new TenantStorageError();
                }
                return database;
            },
        },
        attachmentStorageResolver: attachments,
        mobiusFetchGateway: mobius,
        slackWebApi: slack,
        identityGateway: identity,
        botTriggerLimiter: limiter,
        slackAppDatabases: sharded
            ? [
                  { database: legacyDatabase, shardIds: [null] },
                  { database, shardIds: [placement.d1ShardId] },
              ]
            : [{ database, shardIds: [null] }],
    };
    const infrastructure = { config, gateways, logger: slackLogger };
    const cx = createSlackDependencies({
        ...infrastructure,
        gateways: {
            ...gateways,
            humanIdentity,
            mobius: createMobiusGateway(infrastructure),
            slackAppDirectory: new DatabaseSlackAppDirectory(infrastructure),
        },
    });
    const storage = cx.storages.slackEventStorage;
    const signal = new AbortController().signal;
    const tenant = await tenantShards.resolve("tenant-1", signal);
    const connections = cx.storages.mobiusConnectionStorage;
    await storage.registerApp(
        tenant,
        {
            botId: "bot-1",
            appName: "Test",
            clientId: "client-1",
            clientSecretEncrypted: await cipher.encrypt("client-secret", signal),
            oauthRedirectUri: "https://slack.example.test/mobius-slack/api/slack/oauth/callback",
            signingSecretEncrypted: await cipher.encrypt("signing-secret", signal),
            slackAppId: "A123",
            tenantId: "tenant-1",
            timestamp: Date.now(),
        },
        signal,
    );
    await connections.saveBinding(
        tenant,
        await cx.gateways.mobius.connectBot("tenant-1", "bot-1", mobius.ownBot("mobius-bot-1"), signal),
        signal,
    );
    await storage.upsertInstallation(
        tenant,
        {
            botTokenEncrypted: await cipher.encrypt("xoxb-token", signal),
            installedAt: Date.now(),
            slackAppRecordId: 1,
            slackBotUserId: "U_BOT",
            slackTeamId: "T123",
            slackTeamName: "Example",
            tenantId: "tenant-1",
        },
        signal,
    );
    const application = createSlackApplication();
    const fetchFile = createSlackFileHandler(cx.services.slackFiles, cx.gateways.tenantShardingDirectory);
    const consumer = cx.services.queueConsumer;
    const queueErrors: unknown[] = [];
    const request = async (url: string, init?: RequestInit): Promise<Response> => {
        const response = url.startsWith("/mobius-slack/api/files/")
            ? await fetchFile(new Request(new URL(url, "https://slack.example.test"), init))
            : await application.request(url, init, cx);
        while (pending.length > 0) {
            const message = pending.shift();
            if (message === undefined) {
                break;
            }
            try {
                await consumer.consume(message, init?.signal ?? signal);
            } catch (error) {
                queueErrors.push(error);
            }
        }
        return response;
    };
    return {
        database,
        request,
        signedRequest: createSignedRequest(request),
        humanToken,
        slack,
        mobius,
        identity,
        limiter,
        tenantShards,
        attachments,
        queueErrors,
    };
}
