import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appUser = sqliteTable("app_user", {
    id: text("id").primaryKey().notNull(),
    createdAt: integer("created_at").notNull(),
});
