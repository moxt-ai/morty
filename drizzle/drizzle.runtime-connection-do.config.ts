import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/runtime-connection-do",
    schema: "packages/relay/src/schema/runtime-connection-do/*.ts",
});
