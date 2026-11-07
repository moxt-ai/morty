import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/recording/migrations/recording-directory-do",
    schema: "packages/recording/src/schema/recording-directory-do/*.ts",
});
