import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/pairing-do",
    schema: "packages/worker/src/computer-relay/schema/pairing-do/*.ts",
});
