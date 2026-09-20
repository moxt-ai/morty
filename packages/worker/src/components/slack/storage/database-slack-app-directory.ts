import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { slackApp } from "../../../schema/index.ts";
import { tenantContext } from "../entity/tenant-context.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import type { SecretCipher } from "../infra/util/secret-cipher.ts";
import type { SlackAppDirectory } from "./slack-app-directory.ts";
import { TenantStorageError } from "./tenant-storage-error.ts";

const rowSchema = v.object({ tenant_id: v.pipe(v.string(), v.minLength(1)), signing_secret_encrypted: v.string() });

export class DatabaseSlackAppDirectory implements SlackAppDirectory {
    readonly #database: SqlDatabase;
    readonly #cipher: SecretCipher;
    constructor(database: SqlDatabase, cipher: SecretCipher) {
        this.#database = database;
        this.#cipher = cipher;
    }
    readonly find: SlackAppDirectory["find"] = async (slackAppId, signal) => {
        const value = await this.#database.execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({ tenantId: slackApp.tenantId, signingSecretEncrypted: slackApp.signingSecretEncrypted })
                    .from(slackApp)
                    .where(and(eq(slackApp.slackAppId, slackAppId), eq(slackApp.status, "enabled")))
                    .get(),
        );
        if (value === undefined) {
            return null;
        }
        const row = v.safeParse(
            v.object({ tenantId: rowSchema.entries.tenant_id, signingSecretEncrypted: v.string() }),
            value,
        );
        if (!row.success) {
            throw new TenantStorageError();
        }
        return {
            tenant: tenantContext(row.output.tenantId),
            signingSecret: await this.#cipher.decrypt(row.output.signingSecretEncrypted, signal),
        };
    };
}
