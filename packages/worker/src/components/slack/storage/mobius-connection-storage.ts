import * as v from "valibot";
import { type MobiusBinding, mobiusBindingSchema } from "../entity/mobius-binding";
import type { TenantContext } from "../entity/tenant-context";
import type { DatabaseResolver } from "../infra/database-resolver";
import type { SecretCipher } from "../infra/util/secret-cipher";

export class MobiusConnectionStorage {
    readonly #database: DatabaseResolver;
    readonly #cipher: SecretCipher;
    constructor(cx: {
        readonly gateways: { readonly databaseResolver: DatabaseResolver; readonly secretEncryption: SecretCipher };
    }) {
        this.#database = cx.gateways.databaseResolver;
        this.#cipher = cx.gateways.secretEncryption;
    }
    readonly saveBinding = async (
        tenant: TenantContext,
        binding: MobiusBinding,
        signal: AbortSignal,
    ): Promise<void> => {
        const encrypted = await this.#cipher.encrypt(binding.credential, signal);
        await this.#database.resolve().run(
            `INSERT INTO slack_mobius_binding (tenant_id, slack_bot_id, bot_id, connection_id, credential_encrypted, delivery_target_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(tenant_id, slack_bot_id)
             DO UPDATE SET bot_id = excluded.bot_id, connection_id = excluded.connection_id, credential_encrypted = excluded.credential_encrypted, delivery_target_id = excluded.delivery_target_id`,
            [
                tenant.tenantId,
                binding.slackBotId,
                binding.botId,
                binding.connectionId,
                encrypted,
                binding.deliveryTargetId,
            ],
            signal,
        );
    };
    readonly findBinding = async (
        _tenant: TenantContext,
        tenantId: string,
        slackBotId: string,
        signal: AbortSignal,
    ): Promise<MobiusBinding | null> => {
        const value = await this.#database
            .resolve()
            .first(
                "SELECT bot_id, connection_id, delivery_target_id, credential_encrypted FROM slack_mobius_binding WHERE tenant_id = ?1 AND slack_bot_id = ?2",
                [tenantId, slackBotId],
                signal,
            );
        if (value === null) {
            return null;
        }
        const row = v.parse(
            v.object({
                bot_id: v.string(),
                connection_id: v.string(),
                delivery_target_id: v.string(),
                credential_encrypted: v.string(),
            }),
            value,
        );
        return v.parse(mobiusBindingSchema, {
            tenantId,
            slackBotId,
            botId: row.bot_id,
            connectionId: row.connection_id,
            deliveryTargetId: row.delivery_target_id,
            credential: await this.#cipher.decrypt(row.credential_encrypted, signal),
        });
    };
    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) => {
        const value = await this.#database.resolve().first(
            `SELECT json_group_array(json_object('id', a.slack_bot_id, 'name', a.app_name, 'botId', b.bot_id)) AS bots
             FROM slack_app a LEFT JOIN slack_mobius_binding b ON a.tenant_id = b.tenant_id AND a.slack_bot_id = b.slack_bot_id
             WHERE a.tenant_id = ?1 AND a.status = 'enabled'`,
            [tenant.tenantId],
            signal,
        );
        const row = v.parse(v.object({ bots: v.string() }), value);
        return v
            .parse(
                v.array(v.object({ id: v.string(), name: v.string(), botId: v.nullable(v.string()) })),
                JSON.parse(row.bots),
            )
            .map((bot) => ({
                id: bot.id,
                name: bot.name,
                binding:
                    bot.botId === null ? { kind: "unbound" as const } : { kind: "bound" as const, botId: bot.botId },
            }));
    };
}
