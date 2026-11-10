import type { ProjectStore } from "../../infra/project-store.ts";

export class ChannelCredentialService {
    readonly #store: ProjectStore;

    constructor(store: ProjectStore) {
        this.#store = store;
    }

    readonly isRuntimeActive = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const active = await this.#store.isRuntimeActive(identity.computerId, signal);
        signal.throwIfAborted();
        return active;
    };
}
