import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-core/migrations/relay-operations-do",
    schema: "packages/relay-core/src/schema/relay-operations-do/*.ts",
});
