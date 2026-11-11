import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { and, eq } from "drizzle-orm";
import type { ComputerManagementStore } from "../../computer-relay/components/management/storage/computer-management-store.ts";
import {
    type ProjectRow,
    ProjectRowSchema,
    type RelayAuditRecord,
    type RelayComputerScopeRow,
    RelayComputerScopeRowSchema,
} from "../../contracts/relay/relay-records.ts";
import { computerAccount } from "../../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { computerDirectoryDrizzle } from "./relay-drizzle-database.ts";
import { projectServed } from "./relay-lifecycle.ts";

const projectRow = {
    computer_id: computerAccount.computerId,
    user_id: computerAccount.userId,
    display_name: computerAccount.displayName,
    client_reference: computerAccount.clientReference,
    idempotency_key: computerAccount.idempotencyKey,
    lifecycle: computerAccount.lifecycle,
    location_hint: computerAccount.locationHint,
    created_at: computerAccount.createdAt,
    updated_at: computerAccount.updatedAt,
    deleted_at: computerAccount.deletedAt,
};

export class ComputerManagementStorage {
    readonly database: D1Database;
    readonly projects: {
        readonly forProject: (
            computerId: string,
        ) => Pick<ComputerManagementStore, "holdsAccess" | "recordAudit" | "readActiveGeneration">;
    };
    constructor(database: D1Database, projects: ComputerManagementStorage["projects"]) {
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
                    .from(computerAccount)
                    .where(and(eq(computerAccount.userId, userId), eq(computerAccount.idempotencyKey, key)))
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
                        user_id: computerAccount.userId,
                        computer_id: computerAccount.computerId,
                        lifecycle: computerAccount.lifecycle,
                    })
                    .from(computerAccount)
                    .where(and(eq(computerAccount.computerId, computerId), projectServed))
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

    readonly registerComputerAccount = async (project: ProjectRow, signal: AbortSignal): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .insert(computerAccount)
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
