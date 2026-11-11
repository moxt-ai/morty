import type { ProjectLocationHint, SessionAccessGrant, SessionAccessHolder } from "@morty-build/client/protocol";
import { decodeComputerPlacement, encodeRelayComputerId } from "../../contracts/computer-id.ts";
import { ComputerManagementError, hasControlCharacters } from "../../contracts/relay/computer-management.ts";
import { PairingDirectoryError, validateIdentifier } from "../../contracts/relay/pairing.ts";
import type { ProjectRow } from "../../contracts/relay/relay-records.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { BackendProjectAccess } from "./backend-project-access.ts";

function displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120 || hasControlCharacters(normalized)) {
        throw new ComputerManagementError("invalid_request", "The display name is invalid", 400);
    }
    return normalized;
}

/** A fixed creation reference recovers its computer; a new reference always allocates another one. */
async function accountComputerId(key: string, locationHint: ProjectLocationHint): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["morty-computer-v1", key]))),
    );
    const localId = btoa(String.fromCharCode(...digest.subarray(0, 18)))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    return encodeRelayComputerId({ locationHint }, localId);
}
function projectResource(row: ProjectRow): object {
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

export class ComputerManagementService {
    readonly #projectAccess: BackendProjectAccess;
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.#projectAccess = new BackendProjectAccess(storage);
        this.storage = storage;
    }

    readonly provisionComputerAccount = async (
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        locationHint: ProjectLocationHint,
        signal: AbortSignal,
    ): Promise<object> => {
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const clientReference = validateIdentifier(
            requestedClientReference || normalizedIdempotencyKey,
            "client_reference",
        );
        const normalizedDisplayName = displayName(requestedDisplayName);
        const computerId = await accountComputerId(normalizedIdempotencyKey, locationHint);
        signal.throwIfAborted();
        const sameRequest = (project: ProjectRow): boolean =>
            project.computer_id === computerId &&
            project.location_hint === locationHint &&
            project.idempotency_key === normalizedIdempotencyKey &&
            project.display_name === normalizedDisplayName &&
            project.client_reference === clientReference;
        const now = Date.now();
        const project: ProjectRow = {
            client_reference: clientReference,
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            idempotency_key: normalizedIdempotencyKey,
            lifecycle: "active",
            location_hint: locationHint,
            computer_id: computerId,
            updated_at: now,
        };
        const persisted = await this.storage.createComputerAccount(project, signal);
        if (!sameRequest(persisted)) {
            throw new ComputerManagementError(
                "idempotency_conflict",
                "The computer account reference is already in use",
                409,
            );
        }
        await this.#recordAccountCreation(persisted, signal);
        return projectResource(persisted);
    };

    readonly #recordAccountCreation = async (project: ProjectRow, signal: AbortSignal): Promise<void> =>
        await this.storage.recordAudit(
            {
                action: "project.created",
                actorId: project.computer_id,
                actorKind: "computer",
                actorRef: project.computer_id,
                auditId: `pae_created_${project.computer_id}`,
                detailsJson: "{}",
                outcome: "succeeded",
                computerId: project.computer_id,
                recordedAt: project.created_at,
                subjectId: project.computer_id,
            },
            signal,
        );

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
