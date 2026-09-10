import * as v from "valibot";
import type { SecretCipher } from "../infra/secret-cipher";
import type { SqlDatabase } from "../infra/sql-database";
import type { TenantShardingDirectory } from "../service/identity/tenant-context";
import type { SlackAppDirectory } from "./slack-app-directory";
import { TenantStorageError } from "./tenant-storage-error";

interface SlackAppDatabase {
    readonly shardIds: readonly (string | null)[];
    readonly database: SqlDatabase;
}

const rowSchema = v.object({ tenant_id: v.pipe(v.string(), v.minLength(1)), signing_secret_encrypted: v.string() });

/** Slack owns discovery SQL and checks uniqueness across all configured databases. */
export class DatabaseSlackAppDirectory implements SlackAppDirectory {
    readonly databases: readonly SlackAppDatabase[];
    readonly tenants: TenantShardingDirectory;
    readonly cipher: SecretCipher;
    constructor(cx: {
        readonly gateways: {
            readonly slackAppDatabases: readonly SlackAppDatabase[];
            readonly tenantShardingDirectory: TenantShardingDirectory;
            readonly secretEncryption: SecretCipher;
        };
    }) {
        const {
            slackAppDatabases: databases,
            tenantShardingDirectory: tenants,
            secretEncryption: cipher,
        } = cx.gateways;
        this.databases = databases;
        this.tenants = tenants;
        this.cipher = cipher;
    }

    readonly find: SlackAppDirectory["find"] = async (slackAppId, signal) => {
        const matches = await Promise.all(
            this.databases.map(async ({ database, shardIds }) => {
                const value = await database.first(
                    "SELECT tenant_id, signing_secret_encrypted FROM slack_app WHERE slack_app_id = ?1 AND status = 'enabled'",
                    [slackAppId],
                    signal,
                );
                if (value === null) {
                    return null;
                }
                const row = v.safeParse(rowSchema, value);
                if (!row.success) {
                    throw new TenantStorageError();
                }
                return { shardIds, row: row.output };
            }),
        );
        const found = matches.filter((match) => match !== null);
        if (found.length === 0) {
            return null;
        }
        const [match] = found;
        if (found.length !== 1 || match === undefined) {
            throw new TenantStorageError();
        }
        const tenant = await this.tenants.resolve(match.row.tenant_id, signal);
        const expected = tenant.tenantSharding.hasShard ? tenant.tenantSharding.shard.d1ShardId : null;
        if (!match.shardIds.includes(expected)) {
            throw new TenantStorageError();
        }
        return { tenant, signingSecret: await this.cipher.decrypt(match.row.signing_secret_encrypted, signal) };
    };
}
