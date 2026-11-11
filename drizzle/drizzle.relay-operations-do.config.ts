import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/connection-do",
    schema: "packages/worker/src/computer-relay/schema/connection-do/*.ts",
});
