import type { ProjectStore } from "../../infra/project-store.ts";

export class ChannelCredentialService {
    readonly #store: ProjectStore;

    constructor(store: ProjectStore) {
        this.#store = store;
    }

    /** The Computer's active pairing generation; null while none is. */
    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const generation = await this.#store.readActiveGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };
}
