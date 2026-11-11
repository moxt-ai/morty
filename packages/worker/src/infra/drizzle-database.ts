import type { DurableObjectDatabase } from "../computer-relay/infra/durable-object-database.ts";

export type RelayDrizzleDatabase = DurableObjectDatabase["orm"];

/** Local queries are synchronous; reject cancellation before touching the owning object's SQLite. */
export function relayDrizzle(database: DurableObjectDatabase, signal: AbortSignal): RelayDrizzleDatabase {
    signal.throwIfAborted();
    return database.orm;
}
