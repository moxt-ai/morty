import type { ProjectLocationHint, SessionAccessGrant, SessionAccessHolder } from "@morty-build/client/protocol";
import { accountComputerId, decodeComputerPlacement } from "../../../../contracts/computer-id.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { ComputerAccessService } from "./computer-access-service.ts";

export class ComputerManagementService {
    readonly #projectAccess: ComputerAccessService;
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.#projectAccess = new ComputerAccessService(storage);
        this.storage = storage;
    }

    /** Creates the computer an account reference names, or returns the one an earlier request created. */
    readonly provisionComputerAccount = async (
        reference: string,
        locationHint: ProjectLocationHint,
        signal: AbortSignal,
    ): Promise<{ readonly computerId: string }> => {
        const computerId = await accountComputerId(validateIdentifier(reference, "client_reference"), locationHint);
        signal.throwIfAborted();
        const persisted = await this.storage.createComputerAccount(
            { created_at: Date.now(), computer_id: computerId },
            signal,
        );
        return { computerId: persisted.computer_id };
    };

    readonly authorizeProject = async (computerId: string, signal: AbortSignal) =>
        await this.#projectAccess.authorize(validateIdentifier(computerId, "computer_id"), signal);
    readonly authorizeSessionCredentialRecord = async (
        computerId: string,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ) => await this.#projectAccess.authorizeSession(validateIdentifier(computerId, "computer_id"), grant, signal);
    /** The active pairing under which the holder can receive a Session credential. */
    readonly currentSessionGeneration = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<number | null> =>
        await this.#projectAccess.currentSessionGeneration(
            validateIdentifier(computerId, "computer_id"),
            holder,
            signal,
        );
    readonly isActive = async (computerId: string, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        if (decodeComputerPlacement(computerId) === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage placement is unavailable");
        }
        const account = await this.storage.readActiveComputerScope(computerId, signal);
        if (account === null) {
            return false;
        }
        signal.throwIfAborted();
        return true;
    };

    readonly requireActiveAccount = async (computerId: string, signal: AbortSignal): Promise<void> => {
        await this.#projectAccess.authorize(validateIdentifier(computerId, "computer_id"), signal);
    };
}
