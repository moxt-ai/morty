import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { computer } from "../schema/project-do/index.ts";

/** Whether a Runtime is still active in the Project's own storage. */
export class ChannelCredentialStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readActiveRuntime = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const runtimes = await database
            .select({ computerId: computer.computerId })
            .from(computer)
            .where(
                and(
                    eq(computer.computerId, identity.computerId),
                    isNotNull(computer.claimedAt),
                    isNull(computer.revokedAt),
                ),
            )
            .limit(1);
        return runtimes.length === 1;
    };
}
