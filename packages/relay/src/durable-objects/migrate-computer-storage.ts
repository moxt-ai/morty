import { relayOperationsDurableObjectMigrations } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { computerDurableObjectMigrations } from "../generated/computer-relay-do-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, relayOperationsDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
