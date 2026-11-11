import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DoSqlDatabase } from "../../../infra/do-sql-database.ts";
import { DatabaseError } from "../../../infra/sql-database.ts";
import { runtimeConnection } from "../../../schema/project-do/index.ts";
import { activeGeneration } from "../../management/storage/runtime-generation.ts";
import type {
    LatestRuntimeConnection,
    RuntimeConnection,
    RuntimeConnectionIdentity,
} from "../entity/runtime-connection.ts";

const connectionFields = {
    computerId: runtimeConnection.computerId,
    connectionEpoch: runtimeConnection.connectionEpoch,
    generation: runtimeConnection.generation,
    connectedAt: runtimeConnection.connectedAt,
};

export class RuntimeConnectionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    /** The current connection: attached, and admitted under the generation that is still active. */
    readonly read = (): RuntimeConnection | null =>
        this.#database.orm
            .select(connectionFields)
            .from(runtimeConnection)
            .where(
                and(
                    isNull(runtimeConnection.disconnectedAt),
                    inArray(runtimeConnection.generation, activeGeneration(runtimeConnection.computerId)),
                ),
            )
            .limit(1)
            .get() ?? null;

    readonly latest = (): LatestRuntimeConnection | null => {
        const row = this.#database.orm
            .select({ ...connectionFields, disconnectedAt: runtimeConnection.disconnectedAt })
            .from(runtimeConnection)
            .limit(1)
            .get();
        if (row === undefined) {
            return null;
        }
        const { disconnectedAt, ...connection } = row;
        return disconnectedAt === null
            ? { ...connection, kind: "connected" }
            : { ...connection, kind: "disconnected", disconnectedAt };
    };

    /** Makes `identity` the computer's latest connection, replacing the one before it. */
    readonly connect = (identity: RuntimeConnectionIdentity, generation: number, now: number): void => {
        const connection = {
            ...identity,
            generation,
            connectedAt: now,
            disconnectedAt: null,
        };
        const result = this.#database.orm
            .insert(runtimeConnection)
            .values(connection)
            .onConflictDoUpdate({ target: runtimeConnection.computerId, set: connection })
            .returning({ computerId: runtimeConnection.computerId })
            .get();
        if (!result) {
            throw new DatabaseError("database_unavailable", "The computer connection could not be recorded");
        }
    };

    readonly disconnect = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#database.orm
            .update(runtimeConnection)
            .set({ disconnectedAt: now })
            .where(
                and(
                    eq(runtimeConnection.computerId, identity.computerId),
                    eq(runtimeConnection.connectionEpoch, identity.connectionEpoch),
                    isNull(runtimeConnection.disconnectedAt),
                ),
            )
            .run();
    };
}
