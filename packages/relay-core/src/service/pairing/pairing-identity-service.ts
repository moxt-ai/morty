import type { VerifiedComputerAccess } from "../../entity/pairing/pairing.ts";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { PairingScopeRow } from "../../entity/pairing/pairing-records.ts";
import type { ComputerRelayStore, ComputerRelayStoreResolver } from "../../infra/computer-relay-store.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

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
    readonly #sources: readonly ComputerRelayStore[];
    readonly #stores: ComputerRelayStoreResolver;
    readonly #projects: ProjectStorageDirectory;
    constructor(
        sources: readonly ComputerRelayStore[],
        stores: ComputerRelayStoreResolver,
        projects: ProjectStorageDirectory,
    ) {
        this.#sources = [...sources];
        this.#stores = stores;
        this.#projects = projects;
    }

    private readonly matchesPlacement = (source: ComputerRelayStore, project: ProjectStorageContext): boolean =>
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
     * presented with another successor is reported as reused, for the caller to end the Computer's access, and one of a
     * Computer whose access already ended as revoked.
     */
    readonly rotateComputer = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
        signal.throwIfAborted();
        try {
            const matches: {
                readonly source: ComputerRelayStore;
                readonly kind: "rotated" | "reused";
                readonly row: PairingScopeRow;
            }[] = [];
            let revoked = false;
            for (const source of this.#sources) {
                const rotation = await source.rotateComputerCredential(presentedHash, successorHash, signal);
                switch (rotation.kind) {
                    case "rotated":
                    case "reused":
                        matches.push({ source, kind: rotation.kind, row: rotation.computer });
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
                throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
            }
            const computerId = validateIdentifier(match.row.computer_id, "computer_id");
            const project = await this.#projects.resolve(computerId, signal);
            signal.throwIfAborted();
            if (project === null) {
                throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
            }
            if (!this.matchesPlacement(match.source, project)) {
                throw new PairingDirectoryError("directory_unavailable", "Computer storage is unavailable");
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
                throw new PairingDirectoryError("directory_timeout", "The Computer directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Computer directory is unavailable", {
                cause,
            });
        }
    };

    private readonly authenticate = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        signal.throwIfAborted();
        try {
            const matches: { readonly computerId: string; readonly source: ComputerRelayStore }[] = [];
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
