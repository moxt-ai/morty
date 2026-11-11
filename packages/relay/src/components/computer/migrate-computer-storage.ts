import { computerDurableObjectMigrations } from "../../generated/project-do-migrations.ts";
import { runtimeConnectionDurableObjectMigrations } from "../../generated/runtime-connection-do-migrations.ts";
import { applyDurableObjectMigrations } from "../../infra/durable-object-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, runtimeConnectionDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
