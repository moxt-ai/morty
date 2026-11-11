import { DatabaseError } from "../../../infra/sql-database.ts";
import type { VerifiedChannelAccess } from "../entity/pairing.ts";
import { PairingDirectoryError, validateIdentifier } from "../entity/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing-identity.ts";
import type { PairingScopeRow } from "../entity/pairing-records.ts";
import type { ProjectStorageContext } from "../entity/project-storage-context.ts";
import type { ProjectStore, ProjectStoreResolver } from "../storage/project-store.ts";
import type { ComputerManagementStorageDirectory } from "./computer-management-storage-directory.ts";

/** A credential that matches nothing, including one stored for a Project that is no longer served. */
function unmatchedCredential(credential: ComputerIdentityCredential): PairingDirectoryError {
    const code =
        credential.kind === "pairing"
            ? "pairing_not_found"
            : credential.kind === "pairing-code"
              ? "invalid_pairing_code"
              : "unauthorized";
    return new PairingDirectoryError(code, "A valid pairing or channel credential is required");
}

/**
 * Finds the Project a credential belongs to by asking the Project stores this execution can search, then confirms
 * that the Relay still serves that Project from the store that matched.
 */
export class ComputerIdentityService {
    readonly #sources: readonly ProjectStore[];
    readonly #stores: ProjectStoreResolver;
    readonly #projects: Pick<ComputerManagementStorageDirectory, "resolve">;
    constructor(
        sources: readonly ProjectStore[],
        stores: ProjectStoreResolver,
        projects: Pick<ComputerManagementStorageDirectory, "resolve">,
    ) {
        this.#sources = [...sources];
        this.#stores = stores;
        this.#projects = projects;
    }

    private readonly matchesPlacement = (source: ProjectStore, project: ProjectStorageContext): boolean =>
        source === this.#stores.resolve(project.computerId);

    readonly authenticateProject = async (
        credential: ComputerIdentityCredential,
        signal: AbortSignal,
    ): Promise<ProjectStorageContext> => {
        const identity = await this.authenticate(credential, signal);
        const project = await this.#projects.resolve(identity.computerId, signal);
        signal.throwIfAborted();
        if (project === null) {
            throw unmatchedCredential(credential);
        }
        if (!this.matchesPlacement(identity.source, project)) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return project;
    };

    /**
     * Presents a daemon credential with its successor. The Project store rotates the credential; a retired credential
     * presented with another successor is reported as reused, for the caller to end the Runtime's access, and one of a
     * Runtime whose access already ended as revoked.
     */
    readonly rotateRuntime = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: VerifiedChannelAccess } | { readonly kind: "revoked" }
    > => {
        signal.throwIfAborted();
        try {
            const matches: {
                readonly source: ProjectStore;
                readonly kind: "rotated" | "reused";
                readonly row: PairingScopeRow;
            }[] = [];
            let revoked = false;
            for (const source of this.#sources) {
                const rotation = await source.rotateRuntimeCredential(presentedHash, successorHash, signal);
                switch (rotation.kind) {
                    case "rotated":
                    case "reused":
                        matches.push({ source, kind: rotation.kind, row: rotation.runtime });
                        break;
                    case "revoked":
                        revoked = true;
                        break;
                    case "unknown":
                        break;
                }
            }
            if (revoked && matches.length === 0) {
                return { kind: "revoked" };
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            const computerId = validateIdentifier(match.row.computer_id, "computer_id");
            const project = await this.#projects.resolve(computerId, signal);
            signal.throwIfAborted();
            if (project === null) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            if (!this.matchesPlacement(match.source, project)) {
                throw new PairingDirectoryError("directory_unavailable", "Runtime storage is unavailable");
            }
            return {
                kind: match.kind,
                access: { computerId },
            };
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Runtime directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Runtime directory is unavailable", {
                cause,
            });
        }
    };

    private readonly authenticate = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        signal.throwIfAborted();
        try {
            const matches: { readonly computerId: string; readonly source: ProjectStore }[] = [];
            for (const source of this.#sources) {
                for (const row of await source.findCredential(credential, signal)) {
                    signal.throwIfAborted();
                    matches.push({ computerId: validateIdentifier(row.computer_id, "computer_id"), source });
                }
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                throw unmatchedCredential(credential);
            }
            return match;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Project directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Project directory is unavailable", { cause });
        }
    };
}
