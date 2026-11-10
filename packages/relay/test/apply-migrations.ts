import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

if (env.TEST_RELAY_MIGRATIONS.length > 0) {
    await applyD1Migrations(env.RELAY_DIRECTORY_DATABASE, env.TEST_RELAY_MIGRATIONS);
}
