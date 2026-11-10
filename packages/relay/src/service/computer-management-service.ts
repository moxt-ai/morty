import type { ProjectLocationHint } from "@morty-build/client/protocol";
import {
    createRandomToken,
    type MachineAccountDirectory,
    type ProjectAccessAuthorizer,
    ProjectPermission,
    validateIdentifier,
} from "@morty-build/relay-core";
import { encodeRelayComputerId } from "../entity/computer-id.ts";
import { ComputerManagementError, hasControlCharacters } from "../entity/computer-management.ts";
import type { ProjectRow } from "../entity/relay-records.ts";
import { sessionAccessRevokedThrough } from "../entity/session-access-revocation.ts";
import type { ComputerManagementStorage } from "../storage/computer-management-storage.ts";
import { BackendProjectAccess } from "./backend-project-access.ts";

function displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120 || hasControlCharacters(normalized)) {
        throw new ComputerManagementError("invalid_request", "The display name is invalid", 400);
    }
    return normalized;
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

export class ComputerManagementService implements ProjectAccessAuthorizer {
    readonly #projectAccess: BackendProjectAccess;
    readonly storage: ComputerManagementStorage;
    constructor(storage: ComputerManagementStorage) {
        this.#projectAccess = new BackendProjectAccess(storage);
        this.storage = storage;
    }

    readonly provisionMachineAccount = async (
        userId: string,
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
        const sameRequest = (project: ProjectRow): boolean =>
            project.display_name === normalizedDisplayName && project.client_reference === clientReference;
        const user = validateIdentifier(userId, "user_id");
        const existing = await this.storage.readProjectByIdempotencyKey(user, normalizedIdempotencyKey, signal);
        if (existing !== null) {
            if (!sameRequest(existing)) {
                throw new ComputerManagementError("idempotency_conflict", "The key was used with another request", 409);
            }
            await this.#recordAccountCreation(existing, signal);
            return projectResource(existing);
        }
        const placement = { locationHint };
        signal.throwIfAborted();
        const now = Date.now();
        const project: ProjectRow = {
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
        if (!(await this.storage.registerMachineAccount(project, signal))) {
            const duplicate = await this.storage.readProjectByIdempotencyKey(user, normalizedIdempotencyKey, signal);
            if (duplicate !== null && sameRequest(duplicate)) {
                await this.#recordAccountCreation(duplicate, signal);
                return projectResource(duplicate);
            }
            throw new ComputerManagementError(
                "idempotency_conflict",
                "The machine account reference is already in use",
                409,
            );
        }
        await this.#recordAccountCreation(project, signal);
        return projectResource(project);
    };

    readonly #recordAccountCreation = async (project: ProjectRow, signal: AbortSignal): Promise<void> =>
        await this.storage.recordAudit(
            {
                action: "project.created",
                actorId: project.user_id,
                actorKind: "application",
                actorRef: project.user_id,
                auditId: `pae_created_${project.computer_id}`,
                detailsJson: "{}",
                outcome: "succeeded",
                computerId: project.computer_id,
                recordedAt: project.created_at,
                subjectId: project.computer_id,
            },
            signal,
        );

    readonly authorizeProject = async (computerId: string, permission: ProjectPermission, signal: AbortSignal) => {
        return await this.#projectAccess.authorize(validateIdentifier(computerId, "computer_id"), [permission], signal);
    };
    readonly authorizeSessionCredentialRecord = async (
        computerId: string,
        permission: ProjectPermission,
        issuedAt: number,
        signal: AbortSignal,
    ) =>
        await this.#projectAccess.authorizeSession(
            validateIdentifier(computerId, "computer_id"),
            [permission],
            issuedAt,
            signal,
        );
    readonly revokeSessionAccess = async (computerId: string, signal: AbortSignal): Promise<number> => {
        await this.authorizeProject(computerId, ProjectPermission.SessionWrite, signal);
        return sessionAccessRevokedThrough(
            await this.storage.recordSessionAccessRevocation(computerId, Date.now(), signal),
        );
    };
    readonly readSessionAccessRevokedThrough = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<number | null> => {
        const revokedAt = await this.storage.readSessionAccessRevocation(
            validateIdentifier(computerId, "computer_id"),
            signal,
        );
        return revokedAt === null ? null : sessionAccessRevokedThrough(revokedAt);
    };
    readonly requireActiveAccount: MachineAccountDirectory["requireActiveAccount"] = async (computerId, signal) => {
        await this.#projectAccess.authorize(validateIdentifier(computerId, "computer_id"), [], signal);
    };
}
