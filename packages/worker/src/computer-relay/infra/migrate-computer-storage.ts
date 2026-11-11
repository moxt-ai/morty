import { applyDurableObjectMigrations } from "../../infra/durable-object-migrations.ts";
import { computerDurableObjectMigrations as identityMigrations } from "../generated/computer-relay-do-migrations.ts";
import { relayOperationsDurableObjectMigrations } from "../generated/connection-do-migrations.ts";
import { computerDurableObjectMigrations } from "../generated/pairing-do-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, relayOperationsDurableObjectMigrations, "connections/");
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
    applyDurableObjectMigrations(storage, identityMigrations, "chat/");
}
