import * as v from "valibot";
import type { SecretCipher } from "../infra/secret-cipher.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { tenantContext } from "../service/identity/tenant-context.ts";
import type { SlackAppDirectory } from "./slack-app-directory.ts";
import { TenantStorageError } from "./tenant-storage-error.ts";

const rowSchema = v.object({ tenant_id: v.pipe(v.string(), v.minLength(1)), signing_secret_encrypted: v.string() });

export class DatabaseSlackAppDirectory implements SlackAppDirectory {
    readonly #database: SqlDatabase;
    readonly #cipher: SecretCipher;
    constructor(cx: {
        readonly gateways: { readonly slackAppDatabase: SqlDatabase; readonly secretEncryption: SecretCipher };
    }) {
        this.#database = cx.gateways.slackAppDatabase;
        this.#cipher = cx.gateways.secretEncryption;
    }
    readonly find: SlackAppDirectory["find"] = async (slackAppId, signal) => {
        const value = await this.#database.first(
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
        return {
            tenant: tenantContext(row.output.tenant_id),
            signingSecret: await this.#cipher.decrypt(row.output.signing_secret_encrypted, signal),
        };
    };
}
