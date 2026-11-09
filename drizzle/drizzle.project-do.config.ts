import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/project-do",
    schema: "packages/relay-core/src/schema/project-do/*.ts",
});
