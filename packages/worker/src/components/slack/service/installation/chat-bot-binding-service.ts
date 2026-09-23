import type { BotConfiguration } from "../../../management/entity/bot-configuration.ts";
import type { ChatBotBinding } from "../../entity/chat-bot-binding.ts";
import type { SlackPlatformGateway } from "../../entity/slack-platform-gateway.ts";
import { SlackServiceError } from "../../entity/slack-service-error.ts";
import type { ChatBotBindingStorage, LocalSlackBot } from "../../storage/chat-bot-binding-storage";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { HumanPrincipal } from "../identity/identity-service";
import type { TenantContext } from "../identity/tenant-context";

export class ChatBotBindingService {
    readonly #projectId: string;
    readonly #platform: SlackPlatformGateway;
    readonly #relayUrl: string;
    readonly #storage: ChatBotBindingStorage;
    readonly #apps: SlackEventStorage;
    constructor(cx: {
        readonly gateways: { readonly platformProjects: SlackPlatformGateway };
        readonly storages: {
            readonly chatBotBindingStorage: ChatBotBindingStorage;
            readonly slackEventStorage: SlackEventStorage;
        };
        readonly config: { readonly mobiusBaseUrl: string; readonly projectId: string };
    }) {
        this.#platform = cx.gateways.platformProjects;
        this.#storage = cx.storages.chatBotBindingStorage;
        this.#apps = cx.storages.slackEventStorage;
        this.#relayUrl = cx.config.mobiusBaseUrl;
        this.#projectId = cx.config.projectId;
    }

    readonly #ownedBot = async (
        tenant: TenantContext,
        botId: string,
        signal: AbortSignal,
    ): Promise<LocalSlackBot & { readonly configuration: BotConfiguration }> => {
        const bot = await this.#storage.readOwnedBot(tenant, botId, signal);
        if (bot === null) {
            throw new SlackServiceError("CHAT_BOT_BINDING_NOT_CONFIGURED", "Choose a Bot owned by this Chat workspace");
        }
        if (bot.configuration === null) {
            throw new SlackServiceError(
                "CHAT_BOT_BINDING_NOT_CONFIGURED",
                "Configure this Chat Bot before using Slack",
            );
        }
        return { ...bot, configuration: bot.configuration };
    };

    readonly #binding = (
        tenantId: string,
        slackBotId: string,
        connectionId: string,
        bot: LocalSlackBot & { readonly configuration: BotConfiguration },
        selection: Pick<ChatBotBinding, "agentRef">,
    ): ChatBotBinding => ({
        tenantId,
        slackBotId,
        botId: bot.botId,
        connectionId,
        projectId: this.#projectId,
        runtimeId: bot.configuration.runtimeId,
        ...selection,
        instructions: bot.instructions,
    });

    readonly #newSelection = async (
        bot: LocalSlackBot & { readonly configuration: BotConfiguration },
        signal: AbortSignal,
    ): Promise<Pick<ChatBotBinding, "agentRef">> => {
        const agent = (await this.#platform.chatAgents(this.#projectId, signal)).find(
            (candidate) =>
                candidate.runtimeId === bot.configuration.runtimeId &&
                candidate.agentRef === bot.configuration.agentRef &&
                candidate.online,
        );
        if (agent === undefined) {
            throw new SlackServiceError("CHAT_BOT_BINDING_NOT_CONFIGURED", "Connect an Agent before using Slack");
        }
        return {
            agentRef: agent.agentRef,
        };
    };

    readonly bind = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        slackBotId: string,
        input: { readonly botId: string },
        signal: AbortSignal,
    ) => {
        const app = await this.#apps.findApp(tenant, principal.tenantId, slackBotId, signal);
        if (app === null || app.status !== "enabled") {
            throw new SlackServiceError("CHAT_BOT_BINDING_NOT_CONFIGURED", "Create this Slack bot before binding Chat");
        }
        const bot = await this.#ownedBot(tenant, input.botId, signal);
        const binding = this.#binding(
            principal.tenantId,
            slackBotId,
            crypto.randomUUID(),
            bot,
            await this.#newSelection(bot, signal),
        );
        await this.#storage.saveBinding(tenant, binding, signal);
        return { kind: "bound" as const, botId: binding.botId };
    };

    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) =>
        await this.#storage.listBots(tenant, signal);

    readonly listOwnedBots = async (tenant: TenantContext, signal: AbortSignal) =>
        await this.#storage.listOwnedBots(tenant, signal);

    readonly createPairing = async (_forwardingToken: string | null, _tenantId: string, signal: AbortSignal) => ({
        ...(await this.#platform.createPairing(this.#projectId, crypto.randomUUID(), signal)),
        relayUrl: this.#relayUrl,
    });

    readonly pairingStatus = async (input: { readonly pairingId: string }, signal: AbortSignal) => {
        const pairing = await this.#platform.readPairing(this.#projectId, input.pairingId, signal);
        return { status: pairing.status };
    };

    readonly resolveBinding = async (
        tenant: TenantContext,
        tenantId: string,
        slackBotId: string,
        signal: AbortSignal,
    ): Promise<ChatBotBinding> => {
        const existing = await this.#storage.findBinding(tenant, tenantId, slackBotId, signal);
        if (existing === null) {
            throw new SlackServiceError("CHAT_BOT_BINDING_NOT_CONFIGURED", "Bind a Chat Bot in Slack settings first");
        }
        const bot = await this.#ownedBot(tenant, existing.botId, signal);
        const binding = this.#binding(tenantId, slackBotId, existing.connectionId, bot, existing);
        await this.#storage.saveBinding(tenant, binding, signal);
        return binding;
    };
}
