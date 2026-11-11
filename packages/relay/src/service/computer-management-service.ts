import type { ComputerLocationHint, SessionAccessGrant, SessionAccessHolder } from "@morty-build/client/protocol";
import {
    type ComputerAccessAuthorizer,
    type ComputerPermission,
    createRandomToken,
    type MachineAccountDirectory,
    validateIdentifier,
} from "@morty-build/relay-core";
import { encodeRelayComputerId } from "../entity/computer-id.ts";
import { ComputerManagementError, hasControlCharacters } from "../entity/computer-management.ts";
import type { ComputerRow } from "../entity/relay-records.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { BackendComputerAccess } from "./backend-computer-access.ts";

function displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120 || hasControlCharacters(normalized)) {
        throw new ComputerManagementError("invalid_request", "The display name is invalid", 400);
    }
    return normalized;
}
function computerResource(row: ComputerRow): object {
    return {
        clientReference: row.client_reference,
        createdAt: new Date(row.created_at).toISOString(),
        deletedAt: typeof row.deleted_at === "number" ? new Date(row.deleted_at).toISOString() : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        computerId: row.computer_id,
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}

export class ComputerManagementService implements ComputerAccessAuthorizer {
    readonly #computerAccess: BackendComputerAccess;
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.#computerAccess = new BackendComputerAccess(storage);
        this.storage = storage;
    }

    readonly provisionMachineAccount = async (
        userId: string,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        locationHint: ComputerLocationHint,
        signal: AbortSignal,
    ): Promise<object> => {
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const clientReference = validateIdentifier(
            requestedClientReference || normalizedIdempotencyKey,
            "client_reference",
        );
        const normalizedDisplayName = displayName(requestedDisplayName);
        const sameRequest = (computer: ComputerRow): boolean =>
            computer.display_name === normalizedDisplayName && computer.client_reference === clientReference;
        const user = validateIdentifier(userId, "user_id");
        const existing = await this.storage.readComputerByIdempotencyKey(user, normalizedIdempotencyKey, signal);
        if (existing !== null) {
            if (!sameRequest(existing)) {
                throw new ComputerManagementError("idempotency_conflict", "The key was used with another request", 409);
            }
            await this.#recordAccountCreation(existing, signal);
            return computerResource(existing);
        }
        const placement = { locationHint };
        signal.throwIfAborted();
        const now = Date.now();
        const computer: ComputerRow = {
            user_id: user,
            client_reference: clientReference,
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            idempotency_key: normalizedIdempotencyKey,
            lifecycle: "active",
            location_hint: placement.locationHint,
            computer_id: encodeRelayComputerId(placement, createRandomToken(18)),
            updated_at: now,
        };
        if (!(await this.storage.registerMachineAccount(computer, signal))) {
            const duplicate = await this.storage.readComputerByIdempotencyKey(user, normalizedIdempotencyKey, signal);
            if (duplicate !== null && sameRequest(duplicate)) {
                await this.#recordAccountCreation(duplicate, signal);
                return computerResource(duplicate);
            }
            throw new ComputerManagementError(
                "idempotency_conflict",
                "The machine account reference is already in use",
                409,
            );
        }
        await this.#recordAccountCreation(computer, signal);
        return computerResource(computer);
    };

    readonly #recordAccountCreation = async (computer: ComputerRow, signal: AbortSignal): Promise<void> =>
        await this.storage.recordAudit(
            {
                action: "project.created",
                actorId: computer.user_id,
                actorKind: "application",
                actorRef: computer.user_id,
                auditId: `pae_created_${computer.computer_id}`,
                detailsJson: "{}",
                outcome: "succeeded",
                computerId: computer.computer_id,
                recordedAt: computer.created_at,
                subjectId: computer.computer_id,
            },
            signal,
        );

    readonly authorizeComputer = async (computerId: string, permission: ComputerPermission, signal: AbortSignal) => {
        return await this.#computerAccess.authorize(
            validateIdentifier(computerId, "computer_id"),
            [permission],
            signal,
        );
    };
    readonly authorizeSessionCredentialRecord = async (
        computerId: string,
        permission: ComputerPermission,
        grant: SessionAccessGrant,
        signal: AbortSignal,
    ) =>
        await this.#computerAccess.authorizeSession(
            validateIdentifier(computerId, "computer_id"),
            [permission],
            grant,
            signal,
        );
    /** The active pairing under which the holder can receive a Session credential. */
    readonly currentSessionGeneration = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<number | null> =>
        await this.#computerAccess.currentSessionGeneration(
            validateIdentifier(computerId, "computer_id"),
            holder,
            signal,
        );
    /** The active computer's owner, read from the authoritative directory. */
    readonly readComputerOwner = async (computerId: string, signal: AbortSignal): Promise<string | null> => {
        const account = await this.storage.readActiveComputerScope(
            validateIdentifier(computerId, "computer_id"),
            signal,
        );
        return account?.user_id ?? null;
    };

    readonly requireActiveAccount: MachineAccountDirectory["requireActiveAccount"] = async (computerId, signal) => {
        await this.#computerAccess.authorize(validateIdentifier(computerId, "computer_id"), [], signal);
    };
}
