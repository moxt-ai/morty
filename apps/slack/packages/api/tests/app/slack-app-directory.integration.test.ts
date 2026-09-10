import { expect, test } from "vitest";
import { SecretCipher } from "../../src/infra/secret-cipher";
import type { TenantContext, TenantShardingDirectory } from "../../src/service/identity/tenant-context";
import { DatabaseSlackAppDirectory } from "../../src/storage/database-slack-app-directory";
import { SlackEventStorage } from "../../src/storage/slack-event-storage";
import { TenantStorageError } from "../../src/storage/tenant-storage-error";
import { createTestDatabase } from "./test-database";

// The host directory owns assignments rather than canned query responses.
class TenantDirectory implements TenantShardingDirectory {
    readonly assignments = new Map<string, TenantContext>();
    readonly resolve = async (tenantId: string, signal: AbortSignal): Promise<TenantContext> => {
        signal.throwIfAborted();
        const tenant = this.assignments.get(tenantId);
        if (tenant === undefined) {
            throw new TenantStorageError();
        }
        return tenant;
    };
    readonly fromClaims = async (tenantId: string, _claims: unknown, signal: AbortSignal) =>
        await this.resolve(tenantId, signal);
}

const tenant: TenantContext = {
    tenantId: "tenant-1",
    tenantSharding: {
        hasShard: true,
        shard: {
            d1ShardId: "apac-01",
            r2BucketId: "apac",
            revision: 1,
        },
    },
};

async function fixture() {
    const database = createTestDatabase();
    const cipher = new SecretCipher(btoa("a".repeat(32)));
    const directory = new TenantDirectory();
    directory.assignments.set(tenant.tenantId, tenant);
    const signal = new AbortController().signal;
    const storage = new SlackEventStorage({
        gateways: {
            databaseResolver: { resolve: () => database },
            secretEncryption: cipher,
            queue: {
                send: async () => {
                    throw new Error("Discovery does not enqueue events");
                },
            },
        },
    });
    await storage.registerApp(
        tenant,
        {
            tenantId: tenant.tenantId,
            botId: "bot-1",
            appName: "Test",
            slackAppId: "A123",
            clientId: "client-1",
            clientSecretEncrypted: await cipher.encrypt("client-secret", signal),
            signingSecretEncrypted: await cipher.encrypt("signing-secret", signal),
            oauthRedirectUri: "https://slack.test/oauth",
            timestamp: Date.now(),
        },
        signal,
    );
    return { database, cipher, directory, signal };
}

test("Given legacy and assigned tenants share a physical database, When Slack discovers an app, Then the shared binding resolves to its assigned tenant", async () => {
    const { database, cipher, directory, signal } = await fixture();
    const apps = new DatabaseSlackAppDirectory({
        gateways: {
            slackAppDatabases: [{ database, shardIds: [null, "apac-01"] }],
            tenantShardingDirectory: directory,
            secretEncryption: cipher,
        },
    });
    expect(await apps.find("A123", signal)).toEqual({ tenant, signingSecret: "signing-secret" });
});

test("Given an app exists in two distinct databases, When Slack discovers it, Then ambiguous ownership is rejected", async () => {
    const first = await fixture();
    const second = await fixture();
    const apps = new DatabaseSlackAppDirectory({
        gateways: {
            slackAppDatabases: [
                { database: first.database, shardIds: ["apac-01"] },
                { database: second.database, shardIds: ["apac-02"] },
            ],
            tenantShardingDirectory: first.directory,
            secretEncryption: first.cipher,
        },
    });
    await expect(apps.find("A123", first.signal)).rejects.toMatchObject({ code: "SLACK_STORAGE_UNAVAILABLE" });
});

test("Given an app is stored outside its tenant assignment, When Slack discovers it, Then the conflicting route is rejected", async () => {
    const { database, cipher, directory, signal } = await fixture();
    const apps = new DatabaseSlackAppDirectory({
        gateways: {
            slackAppDatabases: [{ database, shardIds: ["wnam-01"] }],
            tenantShardingDirectory: directory,
            secretEncryption: cipher,
        },
    });
    await expect(apps.find("A123", signal)).rejects.toMatchObject({ code: "SLACK_STORAGE_UNAVAILABLE" });
});
