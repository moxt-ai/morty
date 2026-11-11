import { computerConnectionDurableObjectMigrations } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { computerDurableObjectMigrations } from "../generated/project-do-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, computerConnectionDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
