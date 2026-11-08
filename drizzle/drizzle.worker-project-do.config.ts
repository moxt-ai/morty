import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/project-do",
    schema: "packages/worker/src/schema/project-do/*.ts",
});
