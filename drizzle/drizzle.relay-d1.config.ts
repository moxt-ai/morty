import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay/migrations/d1",
    schema: ["packages/relay/src/schema/d1/*.ts", "drizzle/retained-relay-*.ts"],
});
