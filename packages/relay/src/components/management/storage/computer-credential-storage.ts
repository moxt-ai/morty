import { relayDrizzle } from "../../../infra/drizzle-database.ts";
import type { SqlDatabase } from "../../../infra/sql-database.ts";
import { activeGeneration } from "./computer-generation.ts";

/** Which pairing generation of a Runtime is active in the Project's own storage. */
export class ComputerCredentialStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readActiveGeneration = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<number | null> => {
        const active = activeGeneration(identity.computerId).as("active_generation");
        const rows = await relayDrizzle(this.#database, signal)
            .select({ generation: active.generation })
            .from(active)
            .limit(1);
        return rows[0]?.generation ?? null;
    };
}
