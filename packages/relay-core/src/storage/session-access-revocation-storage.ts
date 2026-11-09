import { eq, sql } from "drizzle-orm";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { sessionAccessRevocation } from "../schema/project-do/index.ts";

/** A recorded revocation never moves the latest one back, so retries and overlapping revocations converge. */
export const keepLatestSessionAccessRevocation = {
    target: sessionAccessRevocation.computerId,
    set: { revokedAt: sql`max(${sessionAccessRevocation.revokedAt}, excluded.revoked_at)` },
};

/** The one record of when the computer last revoked the Session credentials issued for it. */
export class SessionAccessRevocationStorage {
    readonly #computerId: string;
    readonly #database: SqlDatabase;

    constructor(computerId: string, database: SqlDatabase) {
        this.#computerId = computerId;
        this.#database = database;
    }

    /** Records a revocation at `revokedAt` and returns the computer's latest revocation. */
    readonly record = async (revokedAt: number, signal: AbortSignal): Promise<number> => {
        const rows = await relayDrizzle(this.#database, signal)
            .insert(sessionAccessRevocation)
            .values({ computerId: this.#computerId, revokedAt })
            .onConflictDoUpdate(keepLatestSessionAccessRevocation)
            .returning({ revokedAt: sessionAccessRevocation.revokedAt });
        const row = rows[0];
        if (row === undefined) {
            throw new Error("The Session access revocation was not recorded");
        }
        return row.revokedAt;
    };

    /** The latest time the computer revoked its Session credentials, or null when it never did. */
    readonly read = async (signal: AbortSignal): Promise<number | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ revokedAt: sessionAccessRevocation.revokedAt })
            .from(sessionAccessRevocation)
            .where(eq(sessionAccessRevocation.computerId, this.#computerId))
            .limit(1);
        return rows[0]?.revokedAt ?? null;
    };
}
