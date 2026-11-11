import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/computer-relay",
    schema: "packages/worker/src/schema/computer-relay/*.ts",
});
