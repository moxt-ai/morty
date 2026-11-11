import type { BackendProjectAccess } from "../../../../directory/service/backend-project-access.ts";
import type { ComputerManagementStorageDirectory } from "../../../../directory/service/computer-management-storage-directory.ts";
import type { ComputerRelayStore } from "../../management/storage/computer-relay-store.ts";
import type { ComputerSocketIdentity } from "./computer-service.ts";

export class ComputerCredentialService {
    readonly #store: Pick<ComputerRelayStore, "readActiveGeneration">;
    readonly #projects: Pick<ComputerManagementStorageDirectory, "resolve">;
    readonly #access: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">;

    constructor(
        store: Pick<ComputerRelayStore, "readActiveGeneration">,
        projects: Pick<ComputerManagementStorageDirectory, "resolve">,
        access: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">,
    ) {
        this.#store = store;
        this.#projects = projects;
        this.#access = access;
    }

    /** A generation is active only while the directory still serves the same computer. */
    readonly activeGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const project = await this.#projects.resolve(identity.computerId, signal);
        signal.throwIfAborted();
        if (project === null) {
            return null;
        }
        if (project.computerId !== identity.computerId) {
            throw new Error("The Project placement is invalid");
        }
        const generation = await this.#store.readActiveGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeHostMessage = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "host" }>,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.activeGeneration(identity, signal)) !== null &&
        (await this.#access.grants(identity.computerId, signal))
            ? "granted"
            : "revoked";

    readonly authorizeViewer = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "viewer" }>,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access.grantsSessionCredential(identity.computerId, identity.credential.grant, signal))
            ? "granted"
            : "revoked";
}
