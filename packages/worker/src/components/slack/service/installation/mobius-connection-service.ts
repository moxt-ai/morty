import { type BotBindingInput, type MobiusGateway, MobiusGatewayError } from "../../../../gateway/mobius-gateway";
import type { MobiusConnectionStorage } from "../../storage/mobius-connection-storage";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { HumanPrincipal } from "../identity/identity-service";
import type { TenantContext } from "../identity/tenant-context";

export class MobiusConnectionService {
    readonly #mobius: MobiusGateway;
    readonly #storage: MobiusConnectionStorage;
    readonly #apps: SlackEventStorage;
    constructor(cx: {
        readonly gateways: { readonly mobius: MobiusGateway };
        readonly storages: {
            readonly mobiusConnectionStorage: MobiusConnectionStorage;
            readonly slackEventStorage: SlackEventStorage;
        };
    }) {
        this.#mobius = cx.gateways.mobius;
        this.#storage = cx.storages.mobiusConnectionStorage;
        this.#apps = cx.storages.slackEventStorage;
    }
    readonly bind = async (
        tenant: TenantContext,
        principal: HumanPrincipal,
        slackBotId: string,
        grant: BotBindingInput,
        signal: AbortSignal,
    ) => {
        const app = await this.#apps.findApp(tenant, principal.tenantId, slackBotId, signal);
        if (app === null || app.status !== "enabled") {
            throw new MobiusGatewayError(
                "MOBIUS_BINDING_NOT_CONFIGURED",
                "Create this Slack bot before binding Mobius",
            );
        }
        const previous = await this.#storage.findBinding(tenant, principal.tenantId, slackBotId, signal);
        const binding = await this.#mobius.connectBot(principal.tenantId, slackBotId, grant, signal);
        try {
            await this.#storage.saveBinding(tenant, binding, signal);
        } catch (cause) {
            try {
                await this.#mobius.revoke(binding, AbortSignal.timeout(10_000));
            } finally {
                signal.throwIfAborted();
            }
            throw cause;
        }
        if (previous !== null) {
            await this.#mobius.revoke(previous, signal);
        }
        return { kind: "bound", botId: binding.botId };
    };
    readonly listBots = async (tenant: TenantContext, signal: AbortSignal) =>
        await this.#storage.listBots(tenant, signal);
    readonly resolveBinding = async (
        tenant: TenantContext,
        tenantId: string,
        slackBotId: string,
        signal: AbortSignal,
    ) => {
        const binding = await this.#storage.findBinding(tenant, tenantId, slackBotId, signal);
        if (binding === null) {
            throw new MobiusGatewayError("MOBIUS_BINDING_NOT_CONFIGURED", "Bind a Mobius bot in Slack settings first");
        }
        return binding;
    };
}
