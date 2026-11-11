import { type AnyColumn, and, eq, inArray, max, notInArray } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import { computerPairing, computerPairingRevocation, computerRegistration } from "../schema/computer-relay/index.ts";

const query = new QueryBuilder();

/** A computer, named directly or by the column of the row that names it. */
type ComputerReference = string | AnyColumn;

/** The computer's current pairing generation: its latest one. */
export const currentGeneration = (computerId: ComputerReference) =>
    query
        .select({ generation: max(computerPairing.generation) })
        .from(computerPairing)
        .where(eq(computerPairing.computerId, computerId));

/**
 * The generation whose daemon may act for the computer: the current one, once a daemon claimed it, until its access
 * ends. Every authorization of a Runtime credential or connection reads this one rule.
 */
export const activeGeneration = (computerId: ComputerReference) =>
    query
        .select({ generation: computerRegistration.generation })
        .from(computerRegistration)
        .where(
            and(
                inArray(computerRegistration.generation, currentGeneration(computerId)),
                notInArray(
                    computerRegistration.generation,
                    query.select({ generation: computerPairingRevocation.generation }).from(computerPairingRevocation),
                ),
            ),
        );
