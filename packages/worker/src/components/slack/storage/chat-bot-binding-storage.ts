import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { managedBot, slackApp, slackChatBotBinding } from "../../../schema/index.ts";
import { botConfigurationSchema } from "../../management/entity/bot-configuration.ts";
import { type ChatBotBinding, chatBotBindingSchema } from "../entity/chat-bot-binding";
import type { TenantContext } from "../entity/tenant-context";
import type { DatabaseResolver } from "../infra/database-resolver";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
const localBotSchema = v.pipe(
    v.object({
        botId: identifier,
        configuration: v.nullable(botConfigurationSchema),
        instructions: v.pipe(v.string(), v.maxLength(100000)),
    }),
    v.readonly(),
);
export type LocalSlackBot = v.InferOutput<typeof localBotSchema>;

export class ChatBotBindingStorage {
    readonly #database: DatabaseResolver;
    constructor(cx: { readonly storages: { readonly databaseResolver: DatabaseResolver } }) {
        this.#database = cx.storages.databaseResolver;
    }

    readonly readOwnedBot = async (
        tenant: TenantContext,
        botId: string,
        signal: AbortSignal,
    ): Promise<LocalSlackBot | null> => {
        const row = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({
                        botId: managedBot.botId,
                        bindingId: managedBot.bindingId,
                        runtimeId: managedBot.runtimeId,
                        agentRef: managedBot.agentRef,
                        workspaceRef: managedBot.workspaceRef,
                        agentConfigRevision: managedBot.agentConfigRevision,
                        instructions: managedBot.instructions,
                    })
                    .from(managedBot)
                    .where(and(eq(managedBot.userId, tenant.tenantId), eq(managedBot.botId, botId)))
                    .get(),
        );
        if (row === undefined) {
            return null;
        }
        const configuration = v.safeParse(botConfigurationSchema, row);
        return v.parse(localBotSchema, {
            botId: row.botId,
            configuration: configuration.success ? configuration.output : null,
            instructions: row.instructions,
        });
    };

    readonly saveBinding = async (
        tenant: TenantContext,
        binding: ChatBotBinding,
        signal: AbortSignal,
    ): Promise<void> => {
        const value = v.parse(chatBotBindingSchema, binding);
        if (value.tenantId !== tenant.tenantId) {
            throw new Error("The Chat Bot binding tenant does not match the authorized tenant.");
        }
        await this.#database.resolve().execute(
            "run",
            1,
            signal,
            async (database) =>
                await database
                    .insert(slackChatBotBinding)
                    .values(value)
                    .onConflictDoUpdate({
                        target: [slackChatBotBinding.tenantId, slackChatBotBinding.slackBotId],
                        set: {
                            botId: value.botId,
                            connectionId: value.connectionId,
                            projectId: value.projectId,
                            bindingId: value.bindingId,
                            runtimeId: value.runtimeId,
                            agentRef: value.agentRef,
                            workspaceRef: value.workspaceRef,
                            agentConfigRevision: value.agentConfigRevision,
                            instructions: value.instructions,
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
    ): Promise<ChatBotBinding | null> => {
        const row = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select()
                    .from(slackChatBotBinding)
                    .where(
                        and(eq(slackChatBotBinding.tenantId, tenantId), eq(slackChatBotBinding.slackBotId, slackBotId)),
                    )
                    .get(),
        );
        const parsed = v.safeParse(chatBotBindingSchema, row);
        return parsed.success ? parsed.output : null;
    };

    readonly findMapping = async (
        _tenant: TenantContext,
        tenantId: string,
        slackBotId: string,
        signal: AbortSignal,
    ): Promise<{ readonly botId: string; readonly connectionId: string } | null> => {
        const row = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({ botId: slackChatBotBinding.botId, connectionId: slackChatBotBinding.connectionId })
                    .from(slackChatBotBinding)
                    .where(
                        and(eq(slackChatBotBinding.tenantId, tenantId), eq(slackChatBotBinding.slackBotId, slackBotId)),
                    )
                    .get(),
        );
        const parsed = v.safeParse(v.object({ botId: identifier, connectionId: identifier }), row);
        return parsed.success ? parsed.output : null;
    };

    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) => {
        const bots = await this.#database.resolve().execute(
            "first",
            1,
            signal,
            async (database) =>
                await database
                    .select({ id: slackApp.slackBotId, name: slackApp.appName, botId: slackChatBotBinding.botId })
                    .from(slackApp)
                    .leftJoin(
                        slackChatBotBinding,
                        and(
                            eq(slackApp.tenantId, slackChatBotBinding.tenantId),
                            eq(slackApp.slackBotId, slackChatBotBinding.slackBotId),
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

    readonly listOwnedBots = async (tenant: TenantContext, signal: AbortSignal) => {
        const bots = await this.#database
            .resolve()
            .execute(
                "first",
                1,
                signal,
                async (database) =>
                    await database
                        .select({ botId: managedBot.botId, displayName: managedBot.displayName })
                        .from(managedBot)
                        .where(eq(managedBot.userId, tenant.tenantId)),
            );
        return v.parse(v.array(v.object({ botId: identifier, displayName: v.string() })), bots);
    };
}
