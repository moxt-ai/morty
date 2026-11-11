import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { and, eq } from "drizzle-orm";
import { machineAccount } from "../../../schema/d1/index.ts";
import {
    type ProjectRow,
    ProjectRowSchema,
    type RelayAuditRecord,
    type RelayComputerScopeRow,
    RelayComputerScopeRowSchema,
} from "../entity/relay-records.ts";
import type { ComputerManagementStores } from "./computer-management-store.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { computerDirectoryDrizzle } from "./relay-drizzle-database.ts";
import { projectServed } from "./relay-lifecycle.ts";

const projectRow = {
    computer_id: machineAccount.computerId,
    user_id: machineAccount.userId,
    display_name: machineAccount.displayName,
    client_reference: machineAccount.clientReference,
    idempotency_key: machineAccount.idempotencyKey,
    lifecycle: machineAccount.lifecycle,
    location_hint: machineAccount.locationHint,
    created_at: machineAccount.createdAt,
    updated_at: machineAccount.updatedAt,
    deleted_at: machineAccount.deletedAt,
};

export class ComputerManagementStorage {
    readonly database: D1Database;
    readonly projects: Pick<ComputerManagementStores, "forProject">;
    constructor(database: D1Database, projects: Pick<ComputerManagementStores, "forProject">) {
        this.database = database;
        this.projects = projects;
    }

    readonly readProjectByIdempotencyKey = async (
        userId: string,
        key: string,
        signal: AbortSignal,
    ): Promise<ProjectRow | null> => {
        const rows = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .select(projectRow)
                    .from(machineAccount)
                    .where(and(eq(machineAccount.userId, userId), eq(machineAccount.idempotencyKey, key)))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(ProjectRowSchema, rows[0] ?? null);
    };

    readonly readActiveComputerScope = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<RelayComputerScopeRow | null> => {
        const rows = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .select({
                        user_id: machineAccount.userId,
                        computer_id: machineAccount.computerId,
                        lifecycle: machineAccount.lifecycle,
                    })
                    .from(machineAccount)
                    .where(and(eq(machineAccount.computerId, computerId), projectServed))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(RelayComputerScopeRowSchema, rows[0] ?? null);
    };

    /** Whether `holder`'s access to the computer holds now. */
    readonly holdsAccess = async (
        computerId: string,
        holder: SessionAccessHolder,
        signal: AbortSignal,
    ): Promise<boolean> => await this.projects.forProject(computerId).holdsAccess(holder, signal);
    readonly recordAudit = async (audit: RelayAuditRecord, signal: AbortSignal): Promise<void> =>
        await this.projects.forProject(audit.computerId).recordAudit(audit, signal);

    readonly registerMachineAccount = async (project: ProjectRow, signal: AbortSignal): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .insert(machineAccount)
                    .values({
                        computerId: project.computer_id,
                        userId: project.user_id,
                        displayName: project.display_name,
                        clientReference: project.client_reference,
                        idempotencyKey: project.idempotency_key,
                        lifecycle: "active",
                        createdAt: project.created_at,
                        updatedAt: project.updated_at,
                        deletedAt: null,
                        locationHint: project.location_hint,
                    })
                    .onConflictDoNothing()
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };
}
