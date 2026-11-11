import type { ComputerAccessService } from "../../../../directory/service/computer-access-service.ts";
import type { ComputerManagementService } from "../../../../directory/service/computer-management-service.ts";
import type { ComputerRelayStore } from "../../management/storage/computer-relay-store.ts";
import type { ComputerSocketIdentity } from "./computer-service.ts";

export class ComputerCredentialService {
    readonly #store: Pick<ComputerRelayStore, "readActiveGeneration">;
    readonly #accounts: Pick<ComputerManagementService, "isActive">;
    readonly #access: Pick<ComputerAccessService, "grantsSessionCredential">;

    constructor(
        store: Pick<ComputerRelayStore, "readActiveGeneration">,
        accounts: Pick<ComputerManagementService, "isActive">,
        access: Pick<ComputerAccessService, "grantsSessionCredential">,
    ) {
        this.#store = store;
        this.#accounts = accounts;
        this.#access = access;
    }

    /** A generation is active only while the directory still serves the same computer. */
    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const active = await this.#accounts.isActive(identity.computerId, signal);
        signal.throwIfAborted();
        if (!active) {
            return null;
        }
        const generation = await this.#store.readActiveGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeViewer = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "viewer" }>,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access.grantsSessionCredential(identity.computerId, identity.credential.grant, signal))
            ? "granted"
            : "revoked";
}
