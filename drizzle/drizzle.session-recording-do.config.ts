import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/recording/migrations/session-recording-do",
    schema: "packages/recording/src/schema/session-recording-do/*.ts",
});
