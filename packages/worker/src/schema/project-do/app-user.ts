import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// No current code reads or writes this table. It stays so a rolled-back Worker, which still inserts here when it
// creates an anonymous identity, keeps working; drop it once that rollback is no longer supported.
export const appUser = sqliteTable("app_user", {
    id: text("id").primaryKey().notNull(),
    createdAt: integer("created_at").notNull(),
});
