import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The latest time a Project revoked its Session credentials. */
export const platformProjectSessionAccessRevocation = sqliteTable("platform_project_session_access_revocations", {
    projectId: text("project_id").primaryKey(),
    revokedAt: integer("revoked_at").notNull(),
});
