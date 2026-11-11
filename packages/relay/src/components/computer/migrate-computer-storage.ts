import { computerDurableObjectMigrations } from "../../generated/computer-relay-do-migrations.ts";
import { relayOperationsDurableObjectMigrations } from "../../generated/relay-operations-do-migrations.ts";
import { applyDurableObjectMigrations } from "../../infra/durable-object-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, relayOperationsDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
