import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "migrations/d1",
    schema: "src/schema/d1/*.ts",
});
