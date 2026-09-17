import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clerkUserBinding = sqliteTable("clerk_user_binding", {
    clerkUserId: text("clerk_user_id").primaryKey().notNull(),
    userId: text("user_id").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
});
