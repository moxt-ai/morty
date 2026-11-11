import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/relay-operations-do",
    schema: "packages/relay/src/schema/relay-operations-do/*.ts",
});
