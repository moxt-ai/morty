import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { and, eq } from "drizzle-orm";
import {
    type ComputerRow,
    ComputerRowSchema,
    type RelayAuditRecord,
    type RelayComputerScopeRow,
    RelayComputerScopeRowSchema,
} from "../entity/relay-records.ts";
import type { ComputerManagementStores } from "../infra/computer-management-store.ts";
import { machineAccount } from "../schema/d1/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord } from "./decode-storage-record.ts";
import { computerDirectoryDrizzle } from "./relay-drizzle-database.ts";
import { computerServed } from "./relay-lifecycle.ts";

const computerRow = {
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
    readonly computers: Pick<ComputerManagementStores, "forComputer">;
    constructor(database: D1Database, computers: Pick<ComputerManagementStores, "forComputer">) {
        this.database = database;
        this.computers = computers;
    }

    readonly readComputerByIdempotencyKey = async (
        userId: string,
        key: string,
        signal: AbortSignal,
    ): Promise<ComputerRow | null> => {
        const rows = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .select(computerRow)
                    .from(machineAccount)
                    .where(and(eq(machineAccount.userId, userId), eq(machineAccount.idempotencyKey, key)))
                    .limit(1),
            signal,
        );
        return decodeOptionalStorageRecord(ComputerRowSchema, rows[0] ?? null);
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
                    .where(and(eq(machineAccount.computerId, computerId), computerServed))
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
    ): Promise<boolean> => await this.computers.forComputer(computerId).holdsAccess(holder, signal);
    readonly recordAudit = async (audit: RelayAuditRecord, signal: AbortSignal): Promise<void> =>
        await this.computers.forComputer(audit.computerId).recordAudit(audit, signal);

    readonly registerMachineAccount = async (computer: ComputerRow, signal: AbortSignal): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                computerDirectoryDrizzle(this.database)
                    .insert(machineAccount)
                    .values({
                        computerId: computer.computer_id,
                        userId: computer.user_id,
                        displayName: computer.display_name,
                        clientReference: computer.client_reference,
                        idempotencyKey: computer.idempotency_key,
                        lifecycle: "active",
                        createdAt: computer.created_at,
                        updatedAt: computer.updated_at,
                        deletedAt: null,
                        locationHint: computer.location_hint,
                    })
                    .onConflictDoNothing()
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };
}
