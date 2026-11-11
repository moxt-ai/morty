import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-core/migrations/runtime-connection-do",
    schema: "packages/relay-core/src/schema/computer-connection-do/*.ts",
});
