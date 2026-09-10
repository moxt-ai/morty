import type { SlackQueue } from "../../infra/slack-queue";
import type { SlackEventStorage } from "../../storage/slack-event-storage";
import type { TenantContext } from "../identity/tenant-context";
import type { SlackEventCallbackPayload } from "./events";

export class SlackEventIntakeService {
    readonly #storage: SlackEventStorage;
    readonly #queue: SlackQueue;
    constructor(cx: {
        readonly storages: { readonly slackEventStorage: SlackEventStorage };
        readonly gateways: { readonly queue: SlackQueue };
    }) {
        const { slackEventStorage: storage } = cx.storages;
        const { queue } = cx.gateways;
        this.#storage = storage;
        this.#queue = queue;
    }
    readonly findSigningSecret = async (
        tenant: TenantContext,
        slackAppId: string,
        signal: AbortSignal,
    ): Promise<string | null> => await this.#storage.findSigningSecret(tenant, slackAppId, signal);
    readonly receive = async (
        tenant: TenantContext,
        payload: SlackEventCallbackPayload,
        signal: AbortSignal,
    ): Promise<void> => {
        const tenantId = await this.#storage.findTenantIdBySlackAppId(tenant, payload.api_app_id, signal);
        if (tenantId === null) {
            return;
        }
        const inserted = await this.#storage.insertEvent(tenant, tenantId, payload, signal);
        if (inserted || (await this.#storage.eventNeedsProcessing(tenant, tenantId, payload.event_id, signal))) {
            await this.#queue.send({ kind: "event", payload }, signal);
            signal.throwIfAborted();
        }
    };
}
