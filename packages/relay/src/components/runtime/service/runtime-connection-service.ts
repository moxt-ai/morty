import type { RuntimeConnectionIdentity } from "../entity/runtime-connection.ts";
import type { RuntimeConnectionStorage } from "../storage/runtime-connection-storage.ts";

export class RuntimeConnectionService {
    readonly #storage: RuntimeConnectionStorage;

    constructor(storage: RuntimeConnectionStorage) {
        this.#storage = storage;
    }

    /** The current connection; null when the latest one closed or the generation it was admitted under ended. */
    readonly current = () => this.#storage.read();

    readonly latest = () => this.#storage.latest();

    /** The identity of the next connection: every connection takes a later epoch than any before it. */
    readonly next = (computerId: string): RuntimeConnectionIdentity => ({
        computerId,
        connectionEpoch: (this.#storage.latest()?.connectionEpoch ?? 0) + 1,
    });

    readonly isCurrent = (identity: RuntimeConnectionIdentity): boolean => this.standing(identity) === "current";

    /**
     * Where a daemon connection stands: still the current one; `replaced` by a later connection or closed; or `ended`
     * because the generation it was admitted under no longer authorizes it.
     */
    readonly standing = (identity: RuntimeConnectionIdentity): "current" | "replaced" | "ended" => {
        const latest = this.#storage.latest();
        if (
            latest?.kind !== "connected" ||
            latest.computerId !== identity.computerId ||
            latest.connectionEpoch !== identity.connectionEpoch
        ) {
            return "replaced";
        }
        return this.#storage.read() === null ? "ended" : "current";
    };

    readonly connected = (identity: RuntimeConnectionIdentity, generation: number, now: number): void => {
        this.#storage.connect(identity, generation, now);
    };

    readonly disconnected = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#storage.disconnect(identity, now);
    };
}
