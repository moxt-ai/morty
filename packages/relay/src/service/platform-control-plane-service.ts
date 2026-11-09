import { PLATFORM_APP_PROJECT_PERMISSIONS, type ProjectLocationHint } from "@morty-build/client/protocol";
import {
    createRandomToken,
    type decodeProjectCredential,
    type MachineAccountDirectory,
    type ProjectAccessAuthorizer,
    type ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectPermission,
    validateIdentifier,
} from "@morty-build/relay-core";
import {
    hasControlCharacters,
    PlatformAppCredentialAccess,
    PlatformControlPlaneError,
    type PlatformPrincipal,
    type PlatformProjectPlacementRegistry,
} from "../entity/platform-control-plane.ts";
import {
    decodePlatformProjectPlacement,
    encodePlatformProjectId,
    projectBucketLocation,
} from "../entity/platform-project-id.ts";
import type { CredentialRow, ProjectRow } from "../entity/platform-records.ts";
import { sessionAccessRevokedThrough } from "../entity/session-access-revocation.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import type { AppCredentialAuthenticationService } from "./app-credential-authentication-service.ts";
import { AppCredentialProjectAccess } from "./app-credential-project-access.ts";

const PLATFORM_SERVER_PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze(
    PLATFORM_APP_PROJECT_PERMISSIONS.map(ProjectPermission.named),
);
function displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120 || hasControlCharacters(normalized)) {
        throw new PlatformControlPlaneError("invalid_request", "The display name is invalid", 400);
    }
    return normalized;
}
function actorReference(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length > 200 || hasControlCharacters(normalized)) {
        throw new PlatformControlPlaneError("invalid_request", "The actor reference is invalid", 400);
    }
    return normalized;
}
function iso(value: number): string {
    return new Date(value).toISOString();
}
function projectResource(row: ProjectRow): object {
    return {
        clientReference: row.client_reference,
        createdAt: iso(row.created_at),
        deletedAt: typeof row.deleted_at === "number" ? iso(row.deleted_at) : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        projectId: row.project_id,
        updatedAt: iso(row.updated_at),
    };
}
export class PlatformControlPlaneService implements ProjectAccessAuthorizer {
    constructor(
        storage: PlatformControlPlaneStorage,
        placements: PlatformProjectPlacementRegistry,
        appAuthentication: AppCredentialAuthenticationService,
    ) {
        this.#storage = storage;
        this.#placements = placements;
        this.#appAuthentication = appAuthentication;
        this.#projectAccess = new AppCredentialProjectAccess(storage);
    }
    readonly #storage: PlatformControlPlaneStorage;
    readonly #placements: PlatformProjectPlacementRegistry;
    readonly #appAuthentication: AppCredentialAuthenticationService;
    readonly #projectAccess: AppCredentialProjectAccess;
    readonly resolveProjectPlacement = (projectId: string, signal: AbortSignal): { readonly location: string } => {
        signal.throwIfAborted();
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PlatformControlPlaneError("invalid_request", "The Project identifier is invalid", 400);
        }
        if (!this.#placements.supports(placement)) {
            throw new PlatformControlPlaneError(
                "storage_location_unavailable",
                "The requested storage location is unavailable",
                400,
            );
        }
        return { location: projectBucketLocation(placement.locationHint) };
    };
    readonly provisionMachineAccount = async (
        principal: PlatformPrincipal,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        requestedLocationHint: ProjectLocationHint,
        signal: AbortSignal,
    ): Promise<object> => {
        if (
            principal.scope !== "all-projects" ||
            !PLATFORM_SERVER_PROJECT_PERMISSIONS.every((permission) => principal.permissions.has(permission))
        ) {
            throw new PlatformControlPlaneError(
                "app_provisioning_denied",
                "An App-wide server credential is required",
                403,
            );
        }
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const clientReference = validateIdentifier(
            requestedClientReference.length > 0 ? requestedClientReference : normalizedIdempotencyKey,
            "client_reference",
        );
        const normalizedDisplayName = displayName(requestedDisplayName);
        validateIdentifier(requestedLocationHint, "location_hint");
        const locationHint = requestedLocationHint;
        signal.throwIfAborted();
        // A retry names the same request when it asks for the same Project. The location hint only chooses where a
        // new Project is placed, and the Project records where it was placed, so a retry from elsewhere still matches.
        const sameRequest = (project: ProjectRow): boolean =>
            project.display_name === normalizedDisplayName && project.client_reference === clientReference;
        const existing = await this.#storage.readProjectByIdempotencyKey(
            principal.appId,
            normalizedIdempotencyKey,
            signal,
        );
        if (existing !== null) {
            if (!sameRequest(existing)) {
                throw new PlatformControlPlaneError(
                    "idempotency_conflict",
                    "The Project idempotency key was used with another request",
                    409,
                );
            }
            await this.recordAccountCreation(existing, principal, signal);
            return projectResource(existing);
        }
        const placement = this.#placements.resolveLocationHint(locationHint);
        if (placement === null || !this.#placements.supports(placement)) {
            throw new PlatformControlPlaneError(
                "storage_location_unavailable",
                "The requested storage location is unavailable",
                400,
            );
        }
        const now = Date.now();
        const projectId = encodePlatformProjectId(placement, createRandomToken(18));
        const project: ProjectRow = {
            app_id: principal.appId,
            client_reference: clientReference,
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            idempotency_key: normalizedIdempotencyKey,
            lifecycle: "active",
            location_hint: placement.locationHint,
            project_id: projectId,
            updated_at: now,
        };
        if (!(await this.#storage.registerMachineAccount(project, principal.credentialId, signal))) {
            const duplicate = await this.#storage.readProjectByIdempotencyKey(
                principal.appId,
                normalizedIdempotencyKey,
                signal,
            );
            if (duplicate !== null && sameRequest(duplicate)) {
                await this.recordAccountCreation(duplicate, principal, signal);
                return projectResource(duplicate);
            }
            await this.#appAuthentication.readActiveCredentialByPublicId(principal.publicCredentialId, signal);
            throw new PlatformControlPlaneError(
                "idempotency_conflict",
                "The machine account reference is already in use",
                409,
            );
        }
        await this.recordAccountCreation(project, principal, signal);
        return projectResource(project);
    };
    private readonly recordAccountCreation = async (
        project: ProjectRow,
        principal: PlatformPrincipal,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#storage.recordAudit(
            {
                action: "project.created",
                actorId: principal.appId,
                actorKind: principal.kind,
                actorRef: principal.credentialId,
                appId: principal.appId,
                auditId: `pae_created_${project.project_id}`,
                detailsJson: "{}",
                outcome: "succeeded",
                projectId: project.project_id,
                recordedAt: project.created_at,
                subjectId: project.project_id,
            },
            signal,
        );
    };
    readonly authorize = async (
        credential: ReturnType<typeof decodeProjectCredential>,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        signal.throwIfAborted();
        const row = await this.authenticatedCredential(credential.value, signal);
        const projects = await this.allowedProjects(row, signal);
        if (projects.length !== 1) {
            throw new ProjectAuthenticationError(
                "project_target_required",
                "This AppCredential requires an explicit Project target",
            );
        }
        const projectId = projects[0];
        if (projectId === undefined) {
            throw new ProjectAuthenticationError("project_access_denied", "The AppCredential has no Project access");
        }
        return await this.authorizeCredentialForProject(row, projectId, requiredPermission, actorRef, signal);
    };
    readonly authenticate = async (
        credential: ReturnType<typeof decodeProjectCredential>,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => await this.authorize(credential, requiredPermission, "", signal);
    readonly authorizeProject = async (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        signal.throwIfAborted();
        const row = await this.authenticatedCredential(credentialValue, signal);
        return await this.authorizeCredentialForProject(
            row,
            validateIdentifier(projectId, "project_id"),
            requiredPermission,
            actorReference(actorRef),
            signal,
        );
    };
    readonly authorizeSessionCredentialRecord = async (
        projectId: string,
        credential: CredentialRow,
        requiredPermission: ProjectPermission,
        issuedAt: number,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> =>
        await this.#projectAccess.authorizeSessionCredential(
            credential,
            validateIdentifier(projectId, "project_id"),
            [requiredPermission],
            issuedAt,
            signal,
        );
    readonly revokeSessionAccess = async (
        projectId: string,
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<number> => {
        await this.authorizePlatformCredential(projectId, credentialValue, ProjectPermission.SessionWrite, "", signal);
        return sessionAccessRevokedThrough(
            await this.#storage.recordSessionAccessRevocation(
                validateIdentifier(projectId, "project_id"),
                Date.now(),
                signal,
            ),
        );
    };
    readonly readSessionAccessRevokedThrough = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<number | null> => {
        const revokedAt = await this.#storage.readSessionAccessRevocation(
            validateIdentifier(projectId, "project_id"),
            signal,
        );
        return revokedAt === null ? null : sessionAccessRevokedThrough(revokedAt);
    };
    readonly requireActiveAccount: MachineAccountDirectory["requireActiveAccount"] = async (projectId, signal) => {
        const project = await this.#storage.readActiveProjectScope(validateIdentifier(projectId, "project_id"), signal);
        if (project === null) {
            throw new ProjectAuthenticationError("project_access_denied", "The Project is unavailable");
        }
    };
    readonly authorizePlatformCredential = async (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<PlatformAppCredentialAccess> => {
        const row = await this.authenticatedCredential(credentialValue, signal);
        const project = await this.authorizeCredentialForProject(
            row,
            validateIdentifier(projectId, "project_id"),
            requiredPermission,
            actorReference(actorRef),
            signal,
        );
        return new PlatformAppCredentialAccess(row.app_id, row.public_credential_id, project);
    };
    private readonly authorizeCredentialForProject = async (
        row: CredentialRow,
        projectId: string,
        requiredPermission: ProjectPermission,
        _actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> =>
        await this.#projectAccess.authorize(row, projectId, [requiredPermission], signal);
    private readonly authenticatedCredential = async (
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => await this.#appAuthentication.verify(credentialValue, signal);
    private readonly allowedProjects = async (row: CredentialRow, signal: AbortSignal): Promise<readonly string[]> => {
        const projects = await this.#storage.listActiveProjectIds(row.app_id, signal);
        if (row.all_projects === 1) {
            return Object.freeze(projects);
        }
        return Object.freeze(await this.#storage.scopedProjects(row.credential_id, projects, signal));
    };
}
