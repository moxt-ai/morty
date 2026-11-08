import { PLATFORM_APP_PROJECT_PERMISSIONS, type ProjectLocationHint } from "@morty-build/client/protocol";
import {
    createRandomToken,
    type decodeProjectCredential,
    hashSecret,
    type ProjectAccessAuthorizer,
    type ProjectAccessContext,
    type ProjectApplicationResolver,
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
import type { AppRow, CredentialRow, PlatformAuditRecord, ProjectRow, TenantRow } from "../entity/platform-records.ts";
import { sessionAccessRevokedThrough } from "../entity/session-access-revocation.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import type { AppCredentialAuthenticationService } from "./app-credential-authentication-service.ts";
import { AppCredentialProjectAccess } from "./app-credential-project-access.ts";

type ProjectProvisioningActor = {
    readonly kind: "application";
    readonly tenantId: string;
    readonly subject: string;
    readonly credentialId: string;
};
const PLATFORM_SERVER_PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze(
    PLATFORM_APP_PROJECT_PERMISSIONS.map(ProjectPermission.named),
);
class TenantQuotas {
    readonly activeApps: number;
    readonly activeProjects: number;

    constructor(activeApps: number, activeProjects: number) {
        if (
            !Number.isSafeInteger(activeApps) ||
            activeApps < 1 ||
            activeApps > 10_000 ||
            !Number.isSafeInteger(activeProjects) ||
            activeProjects < 1 ||
            activeProjects > 100_000
        ) {
            throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
        }
        this.activeApps = activeApps;
        this.activeProjects = activeProjects;
    }
}
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
function tenantQuotas(value: unknown): TenantQuotas {
    if (value === undefined) {
        return new TenantQuotas(100, 1_000);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    const quota = Object.freeze(Object.fromEntries(Object.entries(value)));
    if (
        Object.keys(quota).length !== 2 ||
        !Object.hasOwn(quota, "activeApps") ||
        !Object.hasOwn(quota, "activeProjects")
    ) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    return new TenantQuotas(quotaValue(quota, "activeApps"), quotaValue(quota, "activeProjects"));
}
function quotaValue(value: Readonly<Record<string, unknown>>, key: string): number {
    const candidate = value[key];
    if (typeof candidate !== "number") {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    return candidate;
}
function quotasFromRow(row: TenantRow): TenantQuotas {
    return tenantQuotas(decodeObject(row.quotas_json, "The Tenant quota record is invalid"));
}
function projectResource(row: ProjectRow): object {
    return {
        appId: row.app_id,
        clientReference: row.client_reference,
        createdAt: iso(row.created_at),
        deletedAt: typeof row.deleted_at === "number" ? iso(row.deleted_at) : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        projectId: row.project_id,
        tenantId: row.tenant_id,
        updatedAt: iso(row.updated_at),
    };
}
function decodeObject(encoded: string, message: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError("platform_record_invalid", message, 500, { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("platform_record_invalid", message, 500);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}
async function requestDigest(
    display: string,
    clientReference: string,
    locationHint: ProjectLocationHint,
): Promise<string> {
    return await hashSecret(JSON.stringify({ clientReference, displayName: display, locationHint }));
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
    readonly provisionAppProject = async (
        principal: PlatformPrincipal,
        appId: string,
        requestedDisplayName: string,
        idempotencyKey: string,
        clientReference: string,
        locationHint: ProjectLocationHint,
        signal: AbortSignal,
    ): Promise<object> => {
        if (
            principal.appId !== appId ||
            principal.scope !== "all-projects" ||
            !PLATFORM_SERVER_PROJECT_PERMISSIONS.every((permission) => principal.permissions.has(permission))
        ) {
            throw new PlatformControlPlaneError(
                "app_provisioning_denied",
                "An App-wide server credential is required",
                403,
            );
        }
        const app = await this.#storage.readApp(principal.appId, signal);
        if (app === null || app.tenant_id !== principal.tenantId || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        return await this.provisionProject(
            {
                kind: "application",
                tenantId: principal.tenantId,
                subject: principal.appId,
                credentialId: principal.credentialId,
            },
            app,
            requestedDisplayName,
            idempotencyKey,
            clientReference,
            locationHint,
            signal,
        );
    };
    private readonly provisionProject = async (
        access: ProjectProvisioningActor,
        app: AppRow,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        requestedLocationHint: ProjectLocationHint,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const clientReference = validateIdentifier(
            requestedClientReference.length > 0 ? requestedClientReference : normalizedIdempotencyKey,
            "client_reference",
        );
        const normalizedDisplayName = displayName(requestedDisplayName);
        validateIdentifier(requestedLocationHint, "location_hint");
        const locationHint = requestedLocationHint;
        const digest = await requestDigest(normalizedDisplayName, clientReference, locationHint);
        signal.throwIfAborted();
        // A retry names the same request when it asks for the same Project. The location hint only chooses where a
        // new Project is placed, and the Project records where it was placed, so a retry from elsewhere still matches.
        const sameRequest = (project: ProjectRow): boolean =>
            project.display_name === normalizedDisplayName && project.client_reference === clientReference;
        const existing = await this.#storage.readProjectByIdempotencyKey(app.app_id, normalizedIdempotencyKey, signal);
        if (existing !== null) {
            if (!sameRequest(existing)) {
                throw new PlatformControlPlaneError(
                    "idempotency_conflict",
                    "The Project idempotency key was used with another request",
                    409,
                );
            }
            await this.recoverProjectProvisioning(existing, access, signal);
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
        const tenant = await this.readTenant(access.tenantId, signal);
        const quota = quotasFromRow(tenant);
        const usage = await this.#storage.countActiveProjects(access.tenantId, signal);
        if (!Number.isSafeInteger(usage) || usage < 0) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant Project usage is invalid", 500);
        }
        if (usage >= quota.activeProjects) {
            await this.recordQuotaDenial(access, "project", app.app_id, quota.activeProjects, signal);
            throw new PlatformControlPlaneError(
                "tenant_project_quota_exceeded",
                "The Tenant active Project quota is exhausted",
                429,
            );
        }
        const now = Date.now();
        const projectId = encodePlatformProjectId(placement, createRandomToken(18));
        const project: ProjectRow = {
            app_id: app.app_id,
            client_reference: clientReference,
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            idempotency_key: normalizedIdempotencyKey,
            lifecycle: "active",
            location_hint: placement.locationHint,
            project_id: projectId,
            // Kept for released Workers, which still compare it on a retry; this version compares the Project itself.
            request_digest: digest,
            tenant_id: app.tenant_id,
            updated_at: now,
        };
        const stored = await this.#storage.createProject(
            project,
            quota.activeProjects,
            this.auditRecord(
                access.tenantId,
                app.app_id,
                projectId,
                access.kind,
                access.subject,
                access.credentialId,
                "project.created",
                projectId,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!stored.projectCreated) {
            const duplicate = await this.#storage.readProjectByIdempotencyKey(
                app.app_id,
                normalizedIdempotencyKey,
                signal,
            );
            if (duplicate !== null && sameRequest(duplicate)) {
                await this.recoverProjectProvisioning(duplicate, access, signal);
                return projectResource(duplicate);
            }
            // A Project is created only under an active App; a deletion committed after the check above wins.
            if ((await this.#storage.readApp(app.app_id, signal))?.lifecycle !== "active") {
                throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
            }
            await this.recordQuotaDenial(access, "project", app.app_id, quota.activeProjects, signal);
            throw new PlatformControlPlaneError(
                "tenant_project_quota_exceeded",
                "The Tenant active Project quota is exhausted",
                429,
            );
        }
        if (!stored.auditRecorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Project could not be created", 503);
        }
        return projectResource(project);
    };
    private readonly recoverProjectProvisioning = async (
        project: ProjectRow,
        access: ProjectProvisioningActor,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await this.#storage.recordAudit(
            this.auditRecord(
                project.tenant_id,
                project.app_id,
                project.project_id,
                access.kind,
                access.subject,
                access.credentialId,
                "project.created",
                project.project_id,
                "succeeded",
                {},
                project.created_at,
            ),
            signal,
        );
        if (!recorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Project could not be created", 503);
        }
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
    readonly resolveApplicationId: ProjectApplicationResolver["resolveApplicationId"] = async (projectId, signal) => {
        const project = await this.#storage.readActiveProjectScope(validateIdentifier(projectId, "project_id"), signal);
        if (project === null) {
            throw new ProjectAuthenticationError("project_access_denied", "The Project is unavailable");
        }
        return project.app_id;
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
    private readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<TenantRow> => {
        const row = await this.#storage.readTenant(validateIdentifier(tenantId, "tenant_id"), signal);
        if (row === null) {
            throw new PlatformControlPlaneError("tenant_not_found", "The Tenant was not found", 404);
        }
        return row;
    };
    private readonly recordQuotaDenial = async (
        access: ProjectProvisioningActor,
        resource: string,
        subjectId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await this.#storage.recordAudit(
            this.auditRecord(
                access.tenantId,
                resource === "app" ? "" : subjectId,
                "",
                access.kind,
                access.subject,
                access.credentialId,
                "quota.denied",
                subjectId,
                "denied",
                { limit, resource },
                Date.now(),
            ),
            signal,
        );
        if (!recorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The quota denial could not be audited", 503);
        }
    };
    private readonly auditRecord = (
        tenantId: string,
        appId: string,
        projectId: string,
        actorKind: string,
        actorId: string,
        actorRef: string,
        action: string,
        subjectId: string,
        outcome: PlatformAuditRecord["outcome"],
        details: Readonly<Record<string, unknown>>,
        now: number,
    ): PlatformAuditRecord => ({
        action,
        actorId,
        actorKind,
        actorRef: actorReference(actorRef),
        appId,
        auditId: `pae_${createRandomToken(18)}`,
        detailsJson: JSON.stringify(details),
        outcome,
        projectId,
        recordedAt: now,
        subjectId,
        tenantId,
    });
}
