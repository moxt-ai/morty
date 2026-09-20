import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "migrations/project-do",
    schema: "src/schema/project-do/*.ts",
});
