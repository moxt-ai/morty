import { and, eq } from "drizzle-orm";
import type { RuntimeConnectionIdentity } from "../entity/channel/runtime-connection.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DatabaseError } from "../infra/sql-database.ts";
import { runtimeConnectionState } from "../schema/runtime-connection-do/index.ts";

export class RuntimeConnectionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly read = ():
        | (RuntimeConnectionIdentity & { readonly connectedAt: number; readonly state: "online" | "offline" })
        | null => {
        const row = this.#database.orm
            .select({
                runtimeId: runtimeConnectionState.runtimeId,
                connectionEpoch: runtimeConnectionState.connectionEpoch,
                connectionId: runtimeConnectionState.connectionId,
                state: runtimeConnectionState.state,
                connectedAt: runtimeConnectionState.connectedAt,
            })
            .from(runtimeConnectionState)
            .where(eq(runtimeConnectionState.singleton, 1))
            .get();
        if (row === undefined) {
            return null;
        }
        if (!Number.isSafeInteger(row.connectionEpoch) || row.connectionEpoch < 1) {
            throw new DatabaseError("database_unavailable", "The Runtime connection state is invalid");
        }
        return row;
    };

    readonly connect = (identity: RuntimeConnectionIdentity, now: number): void => {
        const connection = {
            runtimeId: identity.runtimeId,
            connectionEpoch: identity.connectionEpoch,
            connectionId: identity.connectionId,
            state: "online",
            connectedAt: now,
            disconnectedAt: null,
        } as const;
        this.#database.orm
            .insert(runtimeConnectionState)
            .values({ singleton: 1, ...connection })
            .onConflictDoUpdate({ target: runtimeConnectionState.singleton, set: connection })
            .run();
    };

    readonly disconnect = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#database.orm
            .update(runtimeConnectionState)
            .set({ state: "offline", disconnectedAt: now })
            .where(
                and(
                    eq(runtimeConnectionState.singleton, 1),
                    eq(runtimeConnectionState.runtimeId, identity.runtimeId),
                    eq(runtimeConnectionState.connectionEpoch, identity.connectionEpoch),
                    eq(runtimeConnectionState.connectionId, identity.connectionId),
                ),
            )
            .run();
    };
}
