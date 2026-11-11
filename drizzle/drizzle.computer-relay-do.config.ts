import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/computer-relay-do",
    schema: "packages/relay/src/schema/computer-relay-do/*.ts",
});
