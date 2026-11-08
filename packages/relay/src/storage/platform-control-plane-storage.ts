import { and, asc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import {
    type AppRow,
    AppRowSchema,
    type CredentialRow,
    CredentialRowSchema,
    type PlatformAuditRecord,
    type PlatformProjectScopeRow,
    PlatformProjectScopeRowSchema,
    type ProjectRow,
    ProjectRowSchema,
    type TenantRow,
    TenantRowSchema,
} from "../entity/platform-records.ts";
import type { PlatformProjectStores } from "../infra/platform-project-store.ts";
import {
    platformApp,
    platformAppCredential,
    platformAppCredentialScope,
    platformDashboardAuditEvent,
    platformProject,
    platformProjectSessionAccessRevocation,
    platformTenant,
} from "../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";
import { appActive, projectServed } from "./platform-lifecycle.ts";

// Row selections keep the SQL column names that the entity schemas decode.
const tenantRow = {
    tenant_id: platformTenant.tenantId,
    display_name: platformTenant.displayName,
    quotas_json: platformTenant.quotasJson,
    created_at: platformTenant.createdAt,
    updated_at: platformTenant.updatedAt,
};

const appRow = {
    app_id: platformApp.appId,
    tenant_id: platformApp.tenantId,
    display_name: platformApp.displayName,
    lifecycle: platformApp.lifecycle,
    default_credential_id: platformApp.initialCredentialId,
    created_at: platformApp.createdAt,
    updated_at: platformApp.updatedAt,
    deleted_at: platformApp.deletedAt,
};

const projectRow = {
    project_id: platformProject.projectId,
    app_id: platformProject.appId,
    tenant_id: platformApp.tenantId,
    display_name: platformProject.displayName,
    client_reference: platformProject.clientReference,
    idempotency_key: platformProject.idempotencyKey,
    request_digest: platformProject.requestDigest,
    lifecycle: platformProject.lifecycle,
    location_hint: platformProject.locationHint,
    created_at: platformProject.createdAt,
    updated_at: platformProject.updatedAt,
    deleted_at: platformProject.deletedAt,
};

const credentialRow = {
    credential_id: platformAppCredential.credentialId,
    public_credential_id: platformAppCredential.publicCredentialId,
    app_id: platformAppCredential.appId,
    tenant_id: platformApp.tenantId,
    secret_digest: platformAppCredential.secretDigest,
    permissions_json: platformAppCredential.permissionsJson,
    all_projects: platformAppCredential.allProjects,
    issued_at: platformAppCredential.issuedAt,
    overlap_ends_at: platformAppCredential.overlapEndsAt,
    replaced_by_credential_id: platformAppCredential.replacedByCredentialId,
    revoked_at: platformAppCredential.revokedAt,
};

export class PlatformControlPlaneStorage {
    readonly #database: D1Database;
    readonly #projects: Pick<PlatformProjectStores, "forProject">;

    constructor(database: D1Database, projects: Pick<PlatformProjectStores, "forProject">) {
        this.#database = database;
        this.#projects = projects;
    }

    readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<TenantRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select(tenantRow)
                    .from(platformTenant)
                    .where(eq(platformTenant.tenantId, tenantId))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(TenantRowSchema, rows[0] ?? null);
    };

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<AppRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select(appRow)
                    .from(platformApp)
                    .where(eq(platformApp.appId, appId))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(AppRowSchema, rows[0] ?? null);
    };

    /**
     * The single writer that ends an App. One batch records the App, each of its Projects and each of its
     * AppCredentials as ended, so readers consult only the entity they read (see platform-lifecycle.ts).
     */
    readonly deleteApp = async (
        appId: string,
        deletedAt: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = platformDrizzle(this.#database);
        const results = await waitForD1(
            () =>
                this.#database.batch([
                    this.statement(
                        database
                            .update(platformApp)
                            .set({ lifecycle: "deleted", deletedAt, updatedAt: deletedAt })
                            .where(and(eq(platformApp.appId, appId), appActive)),
                    ),
                    this.auditOfPreviousChange(audit),
                    this.statement(
                        database
                            .update(platformProject)
                            .set({ lifecycle: "deleted", deletedAt, updatedAt: deletedAt })
                            .where(and(eq(platformProject.appId, appId), projectServed)),
                    ),
                    this.statement(
                        database
                            .update(platformAppCredential)
                            .set({ revokedAt: deletedAt })
                            .where(
                                and(eq(platformAppCredential.appId, appId), isNull(platformAppCredential.revokedAt)),
                            ),
                    ),
                ]),
            signal,
        );
        return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
    };

    readonly readProjectByIdempotencyKey = async (
        appId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ProjectRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select(projectRow)
                    .from(platformProject)
                    .innerJoin(platformApp, eq(platformApp.appId, platformProject.appId))
                    .where(and(eq(platformProject.appId, appId), eq(platformProject.idempotencyKey, idempotencyKey)))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(ProjectRowSchema, rows[0] ?? null);
    };

    readonly readActiveProjectScope = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<PlatformProjectScopeRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({
                        app_id: platformProject.appId,
                        tenant_id: platformApp.tenantId,
                        project_id: platformProject.projectId,
                        lifecycle: platformProject.lifecycle,
                    })
                    .from(platformProject)
                    .innerJoin(platformApp, eq(platformApp.appId, platformProject.appId))
                    .where(and(eq(platformProject.projectId, projectId), projectServed))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(PlatformProjectScopeRowSchema, rows[0] ?? null);
    };

    /**
     * Records that the Project revoked its Session credentials at `revokedAt`. The latest revocation is kept, so retries
     * and overlapping revocations converge. Returns the Project's latest revocation time.
     */
    readonly recordSessionAccessRevocation = async (
        projectId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<number> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .insert(platformProjectSessionAccessRevocation)
                    .values({ projectId, revokedAt })
                    .onConflictDoUpdate({
                        target: platformProjectSessionAccessRevocation.projectId,
                        set: {
                            revokedAt: sql`max(${platformProjectSessionAccessRevocation.revokedAt}, excluded.revoked_at)`,
                        },
                    })
                    .returning({ revokedAt: platformProjectSessionAccessRevocation.revokedAt }),
            signal,
        );
        const row = rows[0];
        if (row === undefined) {
            throw new Error("The Session access revocation was not recorded");
        }
        return row.revokedAt;
    };

    /** The latest time the Project revoked its Session credentials, or null when it never did. */
    readonly readSessionAccessRevocation = async (projectId: string, signal: AbortSignal): Promise<number | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ revokedAt: platformProjectSessionAccessRevocation.revokedAt })
                    .from(platformProjectSessionAccessRevocation)
                    .where(eq(platformProjectSessionAccessRevocation.projectId, projectId))
                    .limit(1),
            signal,
        );
        return rows[0]?.revokedAt ?? null;
    };

    readonly countActiveProjects = async (tenantId: string, signal: AbortSignal): Promise<number> =>
        await waitForD1(async () => await this.servedProjectCount(tenantId), signal);

    readonly createProject = async (
        project: ProjectRow,
        activeProjectLimit: number,
        audit: PlatformAuditRecord,
        signal: AbortSignal,
    ): Promise<{ readonly projectCreated: boolean; readonly auditRecorded: boolean }> => {
        const results = await waitForD1(
            () => this.#database.batch([this.statement(this.projectInsert(project, activeProjectLimit))]),
            signal,
        );
        return {
            projectCreated: results[0]?.meta.changes === 1,
            auditRecorded: results[0]?.meta.changes === 1 && (await this.recordAudit(audit, signal)),
        };
    };

    /** The authoritative grant list is owned by the credential in D1. */
    readonly scopedProjects = async (
        credentialId: string,
        candidates: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ projectId: platformAppCredentialScope.projectId })
                    .from(platformAppCredentialScope)
                    .where(eq(platformAppCredentialScope.credentialId, credentialId))
                    .orderBy(asc(platformAppCredentialScope.projectId)),
            signal,
        );
        const scope = new Set(rows.map((row) => row.projectId));
        return candidates.filter((projectId) => scope.has(projectId));
    };

    private readonly statement = (query: { readonly toSQL: () => { sql: string; params: unknown[] } }) => {
        const { sql: text, params } = query.toSQL();
        return this.#database.prepare(text).bind(...params);
    };

    readonly readCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow | null> =>
        await this.readCredential(eq(platformAppCredential.publicCredentialId, publicCredentialId), signal);

    readonly readCredentialById = async (credentialId: string, signal: AbortSignal): Promise<CredentialRow | null> =>
        await this.readCredential(eq(platformAppCredential.credentialId, credentialId), signal);

    private readonly readCredential = async (match: SQL, signal: AbortSignal): Promise<CredentialRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select(credentialRow)
                    .from(platformAppCredential)
                    .innerJoin(platformApp, eq(platformApp.appId, platformAppCredential.appId))
                    .where(match)
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(CredentialRowSchema, rows[0] ?? null);
    };

    readonly listActiveProjectIds = async (appId: string, signal: AbortSignal): Promise<readonly string[]> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ projectId: platformProject.projectId })
                    .from(platformProject)
                    .where(and(eq(platformProject.appId, appId), projectServed)),
            signal,
        );
        return rows.map((row) => row.projectId);
    };

    readonly recordAudit = async (audit: PlatformAuditRecord, signal: AbortSignal): Promise<boolean> => {
        if (audit.projectId === "") {
            const auditId = audit.action === "project.created" ? `pae_created_${audit.projectId}` : audit.auditId;
            const result = await waitForD1(
                () =>
                    platformDrizzle(this.#database)
                        .insert(platformDashboardAuditEvent)
                        .values({ ...dashboardAudit(audit), auditId })
                        .onConflictDoNothing()
                        .run(),
                signal,
            );
            return result.success;
        }
        await this.#projects.forProject(audit.projectId).recordAudit(audit, signal);
        return true;
    };

    private readonly servedProjectCount = async (tenantId: string): Promise<number> =>
        await platformDrizzle(this.#database).$count(platformProject, this.tenantServedProjects(tenantId));

    /** The Projects a Tenant's Project quota counts. */
    private readonly tenantServedProjects = (tenantId: string) => {
        const database = platformDrizzle(this.#database);
        return and(
            projectServed,
            inArray(
                platformProject.appId,
                database
                    .select({ appId: platformApp.appId })
                    .from(platformApp)
                    .where(eq(platformApp.tenantId, tenantId)),
            ),
        );
    };

    /** Creates a Project only under an active App and while the Tenant's served Projects are below the limit. */
    private readonly projectInsert = (project: ProjectRow, activeProjectLimit: number) => {
        const database = platformDrizzle(this.#database);
        return database.insert(platformProject).select(
            database
                .select({
                    projectId: sql<string>`${project.project_id}`.as("projectId"),
                    appId: platformApp.appId,
                    displayName: sql<string>`${project.display_name}`.as("displayName"),
                    clientReference: sql<string>`${project.client_reference}`.as("clientReference"),
                    idempotencyKey: sql<string>`${project.idempotency_key}`.as("idempotencyKey"),
                    requestDigest: sql<string>`${project.request_digest}`.as("requestDigest"),
                    lifecycle: sql<"active">`'active'`.as("lifecycle"),
                    createdAt: sql<number>`${project.created_at}`.as("createdAt"),
                    updatedAt: sql<number>`${project.updated_at}`.as("updatedAt"),
                    deletedAt: sql<null>`NULL`.as("deletedAt"),
                    locationHint: sql<ProjectRow["location_hint"]>`${project.location_hint}`.as("locationHint"),
                })
                .from(platformApp)
                .where(
                    and(
                        eq(platformApp.appId, project.app_id),
                        eq(platformApp.tenantId, project.tenant_id),
                        appActive,
                        lt(
                            database.$count(platformProject, this.tenantServedProjects(project.tenant_id)),
                            activeProjectLimit,
                        ),
                    ),
                ),
        );
    };

    /**
     * Records the change made by the statement immediately before it in the same batch, and only if that statement
     * changed a row: an audit event is a historical fact, so a write that took no effect leaves none.
     */
    private readonly auditOfPreviousChange = (audit: PlatformAuditRecord): D1PreparedStatement => {
        const database = platformDrizzle(this.#database);
        const event = dashboardAudit(audit);
        return this.statement(
            database
                .insert(platformDashboardAuditEvent)
                .select(
                    database
                        .select({
                            auditId: sql<string>`${event.auditId}`.as("audit_id"),
                            tenantId: sql<string>`${event.tenantId}`.as("tenant_id"),
                            appId: sql<string>`${event.appId}`.as("app_id"),
                            projectId: sql<string>`${event.projectId}`.as("project_id"),
                            actorKind: sql<string>`${event.actorKind}`.as("actor_kind"),
                            actorId: sql<string>`${event.actorId}`.as("actor_id"),
                            actorRef: sql<string>`${event.actorRef}`.as("actor_ref"),
                            action: sql<string>`${event.action}`.as("action"),
                            subjectId: sql<string>`${event.subjectId}`.as("subject_id"),
                            outcome: sql<PlatformAuditRecord["outcome"]>`${event.outcome}`.as("outcome"),
                            detailsJson: sql<string>`${event.detailsJson}`.as("details_json"),
                            recordedAt: sql<number>`${event.recordedAt}`.as("recorded_at"),
                        })
                        .from(sql`(select 1)`)
                        .where(sql`changes() = 1`),
                )
                .onConflictDoNothing(),
        );
    };
}

function dashboardAudit(audit: PlatformAuditRecord): typeof platformDashboardAuditEvent.$inferInsert {
    return {
        auditId: audit.auditId,
        tenantId: audit.tenantId,
        appId: audit.appId,
        projectId: audit.projectId,
        actorKind: audit.actorKind,
        actorId: audit.actorId,
        actorRef: audit.actorRef,
        action: audit.action,
        subjectId: audit.subjectId,
        outcome: audit.outcome,
        detailsJson: audit.detailsJson,
        recordedAt: audit.recordedAt,
    };
}
