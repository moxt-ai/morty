import type { RuntimeConnectionIdentity } from "../../entity/channel/runtime-connection.ts";
import type { RuntimeConnectionStorage } from "../../storage/runtime-connection-storage.ts";

export class RuntimeConnectionService {
    readonly #storage: RuntimeConnectionStorage;

    constructor(storage: RuntimeConnectionStorage) {
        this.#storage = storage;
    }

    readonly current = () => this.#storage.read();

    readonly prepare = (
        computerId: string,
    ): { readonly kind: "conflict" } | { readonly kind: "ready"; readonly identity: RuntimeConnectionIdentity } => {
        const previous = this.#storage.read();
        if (previous?.state === "online" && previous.computerId !== computerId) {
            return { kind: "conflict" };
        }
        return {
            kind: "ready",
            identity: {
                computerId,
                connectionEpoch: (previous?.connectionEpoch ?? 0) + 1,
            },
        };
    };

    readonly isCurrent = (identity: RuntimeConnectionIdentity): boolean => {
        const current = this.#storage.read();
        return (
            current?.state === "online" &&
            current.computerId === identity.computerId &&
            current.connectionEpoch === identity.connectionEpoch
        );
    };

    readonly connected = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#storage.connect(identity, now);
    };

    readonly disconnected = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#storage.disconnect(identity, now);
    };
}
