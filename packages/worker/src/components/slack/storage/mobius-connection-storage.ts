import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { slackApp, slackMobiusBinding } from "../../../schema/index.ts";
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
        await this.#database.resolve().execute(
            "run",
            1,
            signal,
            async (database) =>
                await database
                    .insert(slackMobiusBinding)
                    .values({
                        tenantId: tenant.tenantId,
                        slackBotId: binding.slackBotId,
                        botId: binding.botId,
                        connectionId: binding.connectionId,
                        credentialEncrypted: encrypted,
                        deliveryTargetId: binding.deliveryTargetId,
                    })
                    .onConflictDoUpdate({
                        target: [slackMobiusBinding.tenantId, slackMobiusBinding.slackBotId],
                        set: {
                            botId: binding.botId,
                            connectionId: binding.connectionId,
                            credentialEncrypted: encrypted,
                            deliveryTargetId: binding.deliveryTargetId,
                        },
                    })
                    .run(),
        );
    };
    readonly findBinding = async (
        _tenant: TenantContext,
        tenantId: string,
        slackBotId: string,
        signal: AbortSignal,
    ): Promise<MobiusBinding | null> => {
        const value = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({
                        botId: slackMobiusBinding.botId,
                        connectionId: slackMobiusBinding.connectionId,
                        deliveryTargetId: slackMobiusBinding.deliveryTargetId,
                        credentialEncrypted: slackMobiusBinding.credentialEncrypted,
                    })
                    .from(slackMobiusBinding)
                    .where(
                        and(eq(slackMobiusBinding.tenantId, tenantId), eq(slackMobiusBinding.slackBotId, slackBotId)),
                    )
                    .get(),
        );
        if (value === undefined) {
            return null;
        }
        const row = v.parse(
            v.object({
                botId: v.string(),
                connectionId: v.string(),
                deliveryTargetId: v.string(),
                credentialEncrypted: v.string(),
            }),
            value,
        );
        return v.parse(mobiusBindingSchema, {
            tenantId,
            slackBotId,
            botId: row.botId,
            connectionId: row.connectionId,
            deliveryTargetId: row.deliveryTargetId,
            credential: await this.#cipher.decrypt(row.credentialEncrypted, signal),
        });
    };
    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) => {
        const bots = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({ id: slackApp.slackBotId, name: slackApp.appName, botId: slackMobiusBinding.botId })
                    .from(slackApp)
                    .leftJoin(
                        slackMobiusBinding,
                        and(
                            eq(slackApp.tenantId, slackMobiusBinding.tenantId),
                            eq(slackApp.slackBotId, slackMobiusBinding.slackBotId),
                        ),
                    )
                    .where(and(eq(slackApp.tenantId, tenant.tenantId), eq(slackApp.status, "enabled"))),
        );
        return v
            .parse(v.array(v.object({ id: v.string(), name: v.string(), botId: v.nullable(v.string()) })), bots)
            .map((bot) => ({
                id: bot.id,
                name: bot.name,
                binding:
                    bot.botId === null ? { kind: "unbound" as const } : { kind: "bound" as const, botId: bot.botId },
            }));
    };
}
