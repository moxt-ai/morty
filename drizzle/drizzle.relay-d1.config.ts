import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/worker/migrations/d1",
    schema: "packages/worker/src/schema/d1/*.ts",
});
