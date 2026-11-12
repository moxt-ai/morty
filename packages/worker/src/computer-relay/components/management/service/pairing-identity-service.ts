import type { VerifiedComputerAccess } from "../../../../contracts/relay/pairing.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import { DatabaseError } from "../../../../infra/sql-database.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { ComputerManagementService } from "./computer-management-service.ts";

/** A credential that matches nothing, including one stored for a Project that is no longer served. */
function unmatchedCredential(credential: ComputerIdentityCredential): PairingDirectoryError {
    const code = credential.kind === "pairing-code" ? "invalid_pairing_code" : "unauthorized";
    return new PairingDirectoryError(code, "A valid pairing or channel credential is required");
}

/**
 * Verifies credentials against the owning computer's store, then checks its authoritative directory lifecycle.
 */
export class ComputerIdentityService {
    readonly #computerId: string;
    readonly #store: ComputerRelayStore;
    readonly #accounts: Pick<ComputerManagementService, "isActive">;
    constructor(computerId: string, store: ComputerRelayStore, accounts: Pick<ComputerManagementService, "isActive">) {
        this.#computerId = computerId;
        this.#store = store;
        this.#accounts = accounts;
    }

    readonly authenticate = async (credential: ComputerIdentityCredential, signal: AbortSignal): Promise<void> => {
        const identity = await this.#readIdentity(credential, signal);
        const active = await this.#accounts.isActive(identity.computerId, signal);
        signal.throwIfAborted();
        if (!active) {
            throw unmatchedCredential(credential);
        }
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
            const rotation = await this.#store.rotateComputerCredential(presentedHash, successorHash, signal);
            switch (rotation.kind) {
                case "revoked":
                    return rotation;
                case "unknown":
                    throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
                case "rotated":
                case "reused":
                    break;
                default:
                    return rotation satisfies never;
            }
            const computerId = validateIdentifier(rotation.computer.computer_id, "computer_id");
            const active = await this.#accounts.isActive(computerId, signal);
            signal.throwIfAborted();
            if (!active) {
                throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
            }
            if (computerId !== this.#computerId) {
                throw new PairingDirectoryError("directory_unavailable", "Computer storage is unavailable");
            }
            return {
                kind: rotation.kind,
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

    readonly #readIdentity = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        signal.throwIfAborted();
        try {
            const rows = await this.#store.findCredential(credential, signal);
            signal.throwIfAborted();
            const row = rows[0];
            if (rows.length !== 1 || row === undefined) {
                throw unmatchedCredential(credential);
            }
            const computerId = validateIdentifier(row.computer_id, "computer_id");
            if (computerId !== this.#computerId) {
                throw unmatchedCredential(credential);
            }
            return { computerId };
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
