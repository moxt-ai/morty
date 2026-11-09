import type { ChannelCredentialIdentity } from "../../entity/pairing/pairing-records.ts";
import type { ProjectStore } from "../../infra/project-store.ts";

export class ChannelCredentialService {
    readonly #store: ProjectStore;

    constructor(store: ProjectStore) {
        this.#store = store;
    }

    readonly isRuntimeActive = async (
        identity: { readonly computerId: string; readonly pairingId: string },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const active = await this.#store.isRuntimeActive(identity.pairingId, signal);
        signal.throwIfAborted();
        return active;
    };

    readonly isActive = async (identity: ChannelCredentialIdentity, signal: AbortSignal): Promise<boolean> => {
        const active = await this.#store.isHostCredentialActive(identity, signal);
        signal.throwIfAborted();
        return active;
    };
}
