import { connectionStorageMigrations } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { computerDurableObjectMigrations } from "../generated/computer-relay-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, connectionStorageMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
