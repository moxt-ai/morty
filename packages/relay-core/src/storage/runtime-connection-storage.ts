import { and, eq } from "drizzle-orm";
import type { RuntimeConnectionIdentity } from "../entity/channel/runtime-connection.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DatabaseError } from "../infra/sql-database.ts";
import { computer } from "../schema/project-do/index.ts";

export class RuntimeConnectionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly read = ():
        | (RuntimeConnectionIdentity & {
              readonly connectedAt: number;
              readonly state: "online" | "offline" | "revoked";
          })
        | null => {
        const row = this.#database.orm
            .select({
                computerId: computer.computerId,
                connectionEpoch: computer.connectionEpoch,
                state: computer.state,
                connectedAt: computer.connectedAt,
            })
            .from(computer)
            .limit(1)
            .get();
        if (row === undefined || row.connectedAt === null || row.state === null) {
            return null;
        }
        if (!Number.isSafeInteger(row.connectionEpoch) || row.connectionEpoch < 1) {
            throw new DatabaseError("database_unavailable", "The Runtime connection state is invalid");
        }
        return { ...row, connectedAt: row.connectedAt, state: row.state };
    };

    readonly connect = (identity: RuntimeConnectionIdentity, now: number): void => {
        const connection = {
            connectionEpoch: identity.connectionEpoch,
            state: "online",
            connectedAt: now,
            disconnectedAt: null,
        } as const;
        const result = this.#database.orm
            .update(computer)
            .set(connection)
            .where(eq(computer.computerId, identity.computerId))
            .returning({ computerId: computer.computerId })
            .get();
        if (!result) {
            throw new DatabaseError("database_unavailable", "The computer connection could not be recorded");
        }
    };

    readonly disconnect = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#database.orm
            .update(computer)
            .set({ state: "offline", disconnectedAt: now })
            .where(
                and(
                    eq(computer.computerId, identity.computerId),
                    eq(computer.connectionEpoch, identity.connectionEpoch),
                ),
            )
            .run();
    };
}
