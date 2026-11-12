import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/computer-relay-do",
    schema: "packages/worker/src/computer-relay/schema/computer-relay-do/*.ts",
});
