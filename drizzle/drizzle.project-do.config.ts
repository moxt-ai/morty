import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/project-do",
    schema: "packages/relay/src/schema/project-do/*.ts",
});
