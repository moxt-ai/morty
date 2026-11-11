import { RuntimeAccessContext } from "../../entity/authentication/computer-authentication.ts";
import { ComputerScope } from "../../entity/do/session.ts";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { PairingScopeRow } from "../../entity/pairing/pairing-records.ts";
import type { ComputerStorageContext, ComputerStorageDirectory } from "../../infra/computer-storage-directory.ts";
import type { ComputerStore, ComputerStoreResolver } from "../../infra/computer-store.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

/** A credential that matches nothing, including one stored for a Computer that is no longer served. */
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
 * Finds the Computer a credential belongs to by asking the Computer stores this execution can search, then confirms
 * that the Relay still serves that Computer from the store that matched.
 */
export class ComputerIdentityService {
    readonly #sources: readonly ComputerStore[];
    readonly #stores: ComputerStoreResolver;
    readonly #computers: ComputerStorageDirectory;
    constructor(sources: readonly ComputerStore[], stores: ComputerStoreResolver, computers: ComputerStorageDirectory) {
        this.#sources = [...sources];
        this.#stores = stores;
        this.#computers = computers;
    }

    private readonly matchesPlacement = (source: ComputerStore, computer: ComputerStorageContext): boolean =>
        source === this.#stores.resolve(computer.computerId);

    readonly authenticateComputer = async (
        credential: ComputerIdentityCredential,
        signal: AbortSignal,
    ): Promise<ComputerStorageContext> => {
        const identity = await this.authenticate(credential, signal);
        const computer = await this.#computers.resolve(identity.computerId, signal);
        signal.throwIfAborted();
        if (computer === null) {
            throw unmatchedCredential(credential);
        }
        if (!this.matchesPlacement(identity.source, computer)) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return computer;
    };

    /**
     * Presents a daemon credential with its successor. The Computer store rotates the credential; a retired credential
     * presented with another successor is reported as reused, for the caller to end the Runtime's access, and one of a
     * Runtime whose access already ended as revoked.
     */
    readonly rotateRuntime = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: RuntimeAccessContext } | { readonly kind: "revoked" }
    > => {
        signal.throwIfAborted();
        try {
            const matches: {
                readonly source: ComputerStore;
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
            const computer = await this.#computers.resolve(computerId, signal);
            signal.throwIfAborted();
            if (computer === null) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            if (!this.matchesPlacement(match.source, computer)) {
                throw new PairingDirectoryError("directory_unavailable", "Runtime storage is unavailable");
            }
            return {
                kind: match.kind,
                access: new RuntimeAccessContext(new ComputerScope(computerId)),
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
            const matches: { readonly computerId: string; readonly source: ComputerStore }[] = [];
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
                throw new PairingDirectoryError("directory_timeout", "The Computer directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Computer directory is unavailable", {
                cause,
            });
        }
    };
}
