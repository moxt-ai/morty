import { runtimeConnectionDurableObjectMigrations } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { computerDurableObjectMigrations } from "../generated/project-do-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, runtimeConnectionDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
