import { type BotBindingInput, type MobiusGateway, MobiusGatewayError } from "../../../../gateway/mobius-gateway";
import type { MobiusConnectionStorage } from "../../storage/mobius-connection-storage";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { HumanPrincipal } from "../identity/identity-service";
import type { TenantContext } from "../identity/tenant-context";

export class MobiusConnectionService {
    readonly #mobius: MobiusGateway;
    readonly #relayUrl: string;
    readonly #storage: MobiusConnectionStorage;
    readonly #apps: SlackEventStorage;
    constructor(cx: {
        readonly gateways: { readonly mobius: MobiusGateway };
        readonly storages: {
            readonly mobiusConnectionStorage: MobiusConnectionStorage;
            readonly slackEventStorage: SlackEventStorage;
        };
        readonly config: { readonly mobiusBaseUrl: string };
    }) {
        this.#mobius = cx.gateways.mobius;
        this.#storage = cx.storages.mobiusConnectionStorage;
        this.#apps = cx.storages.slackEventStorage;
        this.#relayUrl = cx.config.mobiusBaseUrl;
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

    readonly readBotSetup = async (
        projectId: string,
        botId: string,
        ownerCredential: string,
        forwardingToken: string | null,
        signal: AbortSignal,
    ) => await this.#mobius.botSetup(projectId, botId, ownerCredential, forwardingToken, signal);

    readonly configureBot = async (
        projectId: string,
        botId: string,
        input: Parameters<MobiusGateway["configureBot"]>[2],
        forwardingToken: string | null,
        signal: AbortSignal,
    ) => await this.#mobius.configureBot(projectId, botId, input, forwardingToken, signal);

    readonly createPairing = async (forwardingToken: string | null, tenantId: string, signal: AbortSignal) => ({
        ...(await this.#mobius.createPairing(forwardingToken, signal, tenantId)),
        relayUrl: this.#relayUrl,
    });

    readonly pairingStatus = async (input: Parameters<MobiusGateway["pairingStatus"]>[0], signal: AbortSignal) =>
        await this.#mobius.pairingStatus(input, signal);

    readonly projectStatus = async (projectId: string, forwardingToken: string | null, signal: AbortSignal) =>
        await this.#mobius.projectStatus(projectId, forwardingToken, signal);

    readonly listProjects = async (forwardingToken: string | null, signal: AbortSignal) =>
        await this.#mobius.listProjects(forwardingToken, signal);

    readonly listProjectBots = async (projectId: string, forwardingToken: string | null, signal: AbortSignal) =>
        await this.#mobius.listProjectBots(projectId, forwardingToken, signal);

    readonly createBot = async (
        projectId: string,
        forwardingToken: string | null,
        input: Parameters<MobiusGateway["createBot"]>[2],
        signal: AbortSignal,
    ) => await this.#mobius.createBot(projectId, forwardingToken, input, signal);
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
