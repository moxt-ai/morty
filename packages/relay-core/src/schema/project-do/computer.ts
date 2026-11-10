import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const computer = sqliteTable(
    "computer",
    {
        computerId: text("computer_id").primaryKey(),
        claimedAt: integer("claimed_at"),
        machineName: text("machine_name"),
        workspaceName: text("workspace_name"),
        agentsJson: text("agents_json"),
        connectionEpoch: integer("connection_epoch").notNull().default(0),
        state: text("state", { enum: ["online", "offline", "revoked"] }),
        connectedAt: integer("connected_at"),
        disconnectedAt: integer("disconnected_at"),
        createdAt: integer("created_at").notNull(),
        revokedAt: integer("revoked_at"),
        revokedByOwnerCredentialId: text("revoked_by_owner_credential_id"),
    },
    (table) => [
        check(
            "computer_registration",
            sql`(${table.claimedAt} is null and ${table.machineName} is null and ${table.workspaceName} is null and ${table.agentsJson} is null) or (${table.claimedAt} is not null and ${table.machineName} is not null and ${table.workspaceName} is not null and ${table.agentsJson} is not null)`,
        ),
        check(
            "computer_connection",
            sql`(${table.connectionEpoch} = 0 and ${table.connectedAt} is null and ${table.state} is null) or (${table.connectionEpoch} > 0 and ${table.connectedAt} is not null and ${table.state} is not null and ${table.state} in ('online', 'offline', 'revoked'))`,
        ),
        check(
            "computer_revoked_at_check",
            sql`${table.revokedAt} is null or (typeof(${table.revokedAt}) = 'integer' and ${table.revokedAt} >= 0)`,
        ),
        check(
            "computer_revocation_actor_check",
            sql`${table.revokedByOwnerCredentialId} is null or ${table.revokedAt} is not null`,
        ),
    ],
);
