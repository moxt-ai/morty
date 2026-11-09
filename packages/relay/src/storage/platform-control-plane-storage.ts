import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import {
    type CredentialRow,
    CredentialRowSchema,
    type PlatformAuditRecord,
    type PlatformComputerScopeRow,
    PlatformComputerScopeRowSchema,
    type ProjectRow,
    ProjectRowSchema,
} from "../entity/platform-records.ts";
import type { PlatformProjectStores } from "../infra/platform-project-store.ts";
import { machineAccessRevocation, machineAccount, machineAccountGrant, serviceCredential } from "../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";
import { projectServed } from "./platform-lifecycle.ts";

// Row selections keep the SQL column names that the entity schemas decode.
const projectRow = {
    project_id: machineAccount.computerId,
    app_id: machineAccount.appId,
    display_name: machineAccount.displayName,
    client_reference: machineAccount.clientReference,
    idempotency_key: machineAccount.idempotencyKey,
    lifecycle: machineAccount.lifecycle,
    location_hint: machineAccount.locationHint,
    created_at: machineAccount.createdAt,
    updated_at: machineAccount.updatedAt,
    deleted_at: machineAccount.deletedAt,
};

const credentialRow = {
    credential_id: serviceCredential.credentialId,
    public_credential_id: serviceCredential.publicCredentialId,
    app_id: serviceCredential.appId,
    secret_digest: serviceCredential.secretDigest,
    permissions_json: serviceCredential.permissionsJson,
    all_projects: serviceCredential.allProjects,
    issued_at: serviceCredential.issuedAt,
    overlap_ends_at: serviceCredential.overlapEndsAt,
    replaced_by_credential_id: serviceCredential.replacedByCredentialId,
    revoked_at: serviceCredential.revokedAt,
};

export class PlatformControlPlaneStorage {
    readonly #database: D1Database;
    readonly #projects: Pick<PlatformProjectStores, "forProject">;

    constructor(database: D1Database, projects: Pick<PlatformProjectStores, "forProject">) {
        this.#database = database;
        this.#projects = projects;
    }

    readonly readProjectByIdempotencyKey = async (
        appId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ProjectRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select(projectRow)
                    .from(machineAccount)
                    .where(and(eq(machineAccount.appId, appId), eq(machineAccount.idempotencyKey, idempotencyKey)))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(ProjectRowSchema, rows[0] ?? null);
    };

    readonly readActiveComputerScope = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<PlatformComputerScopeRow | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({
                        app_id: machineAccount.appId,
                        project_id: machineAccount.computerId,
                        lifecycle: machineAccount.lifecycle,
                    })
                    .from(machineAccount)
                    .where(and(eq(machineAccount.computerId, computerId), projectServed))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(PlatformComputerScopeRowSchema, rows[0] ?? null);
    };

    /**
     * Records that the Project revoked its Session credentials at `revokedAt`. The latest revocation is kept, so retries
     * and overlapping revocations converge. Returns the Project's latest revocation time.
     */
    readonly recordSessionAccessRevocation = async (
        computerId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<number> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .insert(machineAccessRevocation)
                    .values({ computerId, revokedAt })
                    .onConflictDoUpdate({
                        target: machineAccessRevocation.computerId,
                        set: {
                            revokedAt: sql`max(${machineAccessRevocation.revokedAt}, excluded.revoked_at)`,
                        },
                    })
                    .returning({ revokedAt: machineAccessRevocation.revokedAt }),
            signal,
        );
        const row = rows[0];
        if (row === undefined) {
            throw new Error("The Session access revocation was not recorded");
        }
        return row.revokedAt;
    };

    /** The latest time the Project revoked its Session credentials, or null when it never did. */
    readonly readSessionAccessRevocation = async (computerId: string, signal: AbortSignal): Promise<number | null> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ revokedAt: machineAccessRevocation.revokedAt })
                    .from(machineAccessRevocation)
                    .where(eq(machineAccessRevocation.computerId, computerId))
                    .limit(1),
            signal,
        );
        const sessionCutoff = rows[0]?.revokedAt ?? null;
        const daemonCutoff = await this.#projects.forProject(computerId).lastDaemonRevocation(signal);
        return sessionCutoff === null ? daemonCutoff : Math.max(sessionCutoff, daemonCutoff ?? 0);
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
                    .select({ computerId: machineAccountGrant.computerId })
                    .from(machineAccountGrant)
                    .where(eq(machineAccountGrant.credentialId, credentialId))
                    .orderBy(asc(machineAccountGrant.computerId)),
            signal,
        );
        const scope = new Set(rows.map((row) => row.computerId));
        return candidates.filter((computerId) => scope.has(computerId));
    };

    readonly readCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow | null> =>
        await this.readCredential(eq(serviceCredential.publicCredentialId, publicCredentialId), signal);

    readonly readCredentialById = async (credentialId: string, signal: AbortSignal): Promise<CredentialRow | null> =>
        await this.readCredential(eq(serviceCredential.credentialId, credentialId), signal);

    private readonly readCredential = async (match: SQL, signal: AbortSignal): Promise<CredentialRow | null> => {
        const rows = await waitForD1(
            () => platformDrizzle(this.#database).select(credentialRow).from(serviceCredential).where(match).limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(CredentialRowSchema, rows[0] ?? null);
    };

    readonly listActiveComputerIds = async (appId: string, signal: AbortSignal): Promise<readonly string[]> => {
        const rows = await waitForD1(
            () =>
                platformDrizzle(this.#database)
                    .select({ computerId: machineAccount.computerId })
                    .from(machineAccount)
                    .where(and(eq(machineAccount.appId, appId), projectServed)),
            signal,
        );
        return rows.map((row) => row.computerId);
    };

    readonly recordAudit = async (audit: PlatformAuditRecord, signal: AbortSignal): Promise<void> => {
        await this.#projects.forProject(audit.computerId).recordAudit(audit, signal);
    };

    readonly registerMachineAccount = async (
        project: ProjectRow,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = platformDrizzle(this.#database);
        const insert = database
            .insert(machineAccount)
            .select(
                database
                    .select({
                        computerId: sql<string>`${project.project_id}`.as("computerId"),
                        appId: serviceCredential.appId,
                        displayName: sql<string>`${project.display_name}`.as("displayName"),
                        clientReference: sql<string>`${project.client_reference}`.as("clientReference"),
                        idempotencyKey: sql<string>`${project.idempotency_key}`.as("idempotencyKey"),
                        lifecycle: sql<"active">`'active'`.as("lifecycle"),
                        createdAt: sql<number>`${project.created_at}`.as("createdAt"),
                        updatedAt: sql<number>`${project.updated_at}`.as("updatedAt"),
                        deletedAt: sql<null>`NULL`.as("deletedAt"),
                        locationHint: sql<ProjectRow["location_hint"]>`${project.location_hint}`.as("locationHint"),
                    })
                    .from(serviceCredential)
                    .where(
                        and(
                            eq(serviceCredential.credentialId, credentialId),
                            eq(serviceCredential.allProjects, 1),
                            sql`(${serviceCredential.replacedByCredentialId} IS NULL OR ${serviceCredential.overlapEndsAt} > ${Date.now()})`,
                            eq(serviceCredential.appId, project.app_id),
                            isNull(serviceCredential.revokedAt),
                        ),
                    ),
            )
            .onConflictDoNothing();
        const result = await waitForD1(() => insert.run(), signal);
        return result.meta.changes === 1;
    };
}
