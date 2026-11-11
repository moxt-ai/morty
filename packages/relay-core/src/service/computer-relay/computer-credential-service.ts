import type { ComputerRelayStore } from "../../infra/computer-relay-store.ts";

export class ComputerCredentialService {
    readonly #store: ComputerRelayStore;

    constructor(store: ComputerRelayStore) {
        this.#store = store;
    }

    /** The Runtime's active pairing generation; null while none is. */
    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const generation = await this.#store.readActiveGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };
}
