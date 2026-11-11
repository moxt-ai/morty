import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/computer-relay",
    schema: "packages/relay-core/src/schema/computer-relay/*.ts",
});
