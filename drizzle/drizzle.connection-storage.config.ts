import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-core/migrations/connection-storage",
    schema: "packages/relay-core/src/schema/connection-storage/*.ts",
});
