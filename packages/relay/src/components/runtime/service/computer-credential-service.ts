import { PROJECT_HOST_PERMISSIONS, ProjectPermission } from "../../management/entity/project-authentication.ts";
import type { BackendProjectAccess } from "../../management/service/backend-project-access.ts";
import type { ComputerManagementStorageDirectory } from "../../management/service/computer-management-storage-directory.ts";
import type { ComputerRelayStoreResolver } from "../../management/storage/computer-relay-store.ts";
import type { ComputerSocketIdentity } from "./computer-service.ts";

export class ComputerCredentialService {
    readonly #stores: ComputerRelayStoreResolver;
    readonly #projects: Pick<ComputerManagementStorageDirectory, "resolve">;
    readonly #access: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">;

    constructor(
        stores: ComputerRelayStoreResolver,
        projects: Pick<ComputerManagementStorageDirectory, "resolve">,
        access: Pick<BackendProjectAccess, "grants" | "grantsSessionCredential">,
    ) {
        this.#stores = stores;
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
        const generation = await this.#stores
            .resolve(project.computerId)
            .readActiveGeneration(identity.computerId, signal);
        signal.throwIfAborted();
        return generation;
    };

    readonly authorizeHostMessage = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "host" }>,
        permission: ProjectPermission | null,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked" | "denied"> => {
        if (
            (await this.activeGeneration(identity, signal)) === null ||
            !(await this.#access.grants(identity.computerId, PROJECT_HOST_PERMISSIONS, signal))
        ) {
            return "revoked";
        }
        if (permission === null || PROJECT_HOST_PERMISSIONS.includes(permission)) {
            return "granted";
        }
        return (await this.#access.grants(identity.computerId, [permission], signal)) ? "granted" : "denied";
    };

    readonly authorizeViewer = async (
        identity: Extract<ComputerSocketIdentity, { readonly role: "viewer" }>,
        signal: AbortSignal,
    ): Promise<"granted" | "revoked"> =>
        (await this.#access.grantsSessionCredential(
            identity.computerId,
            identity.credential.grant,
            [ProjectPermission.SessionRead],
            signal,
        ))
            ? "granted"
            : "revoked";
}
