import { relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { activeGeneration } from "./computer-generation.ts";

/** Which pairing generation of the computer is active in its own storage. */
export class ComputerCredentialStorage {
    readonly #computerId: string;
    readonly #database: DurableObjectDatabase;

    constructor(computerId: string, database: DurableObjectDatabase) {
        this.#computerId = computerId;
        this.#database = database;
    }

    readonly readActiveGeneration = async (signal: AbortSignal): Promise<number | null> => {
        const active = activeGeneration(this.#computerId).as("active_generation");
        const rows = await relayDrizzle(this.#database, signal)
            .select({ generation: active.generation })
            .from(active)
            .limit(1);
        return rows[0]?.generation ?? null;
    };
}
