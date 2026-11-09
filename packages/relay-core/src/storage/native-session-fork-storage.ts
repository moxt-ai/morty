import { and, eq, isNull } from "drizzle-orm";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { nativeSessionFork } from "../schema/runtime-connection-do/index.ts";

export class NativeSessionForkStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly read = (computerId: string, operationId: string) =>
        this.#database.orm
            .select({
                requestHash: nativeSessionFork.requestHash,
                resultJson: nativeSessionFork.resultJson,
                attemptJson: nativeSessionFork.attemptJson,
            })
            .from(nativeSessionFork)
            .where(and(eq(nativeSessionFork.computerId, computerId), eq(nativeSessionFork.operationId, operationId)))
            .get();

    readonly start = (computerId: string, operationId: string, requestHash: string, attemptJson: string): void => {
        this.#database.orm
            .insert(nativeSessionFork)
            .values({ computerId, operationId, requestHash, attemptJson })
            .run();
    };

    readonly complete = (computerId: string, operationId: string, resultJson: string): void => {
        this.#database.orm
            .update(nativeSessionFork)
            .set({ resultJson, attemptJson: null })
            .where(and(eq(nativeSessionFork.computerId, computerId), eq(nativeSessionFork.operationId, operationId)))
            .run();
    };

    /** Forget an attempt that never completed, so its operation may run again. */
    readonly abandon = (computerId: string, operationId: string): void => {
        this.#database.orm
            .delete(nativeSessionFork)
            .where(
                and(
                    eq(nativeSessionFork.computerId, computerId),
                    eq(nativeSessionFork.operationId, operationId),
                    isNull(nativeSessionFork.resultJson),
                ),
            )
            .run();
    };
}
