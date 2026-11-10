import { type AnyColumn, and, eq, inArray, max, notInArray } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import { runtimePairing, runtimeRegistration, runtimeRevocation } from "../schema/project-do/index.ts";

const query = new QueryBuilder();

/** A computer, named directly or by the column of the row that names it. */
type ComputerReference = string | AnyColumn;

/** The computer's current pairing generation: its latest one. */
export const currentGeneration = (computerId: ComputerReference) =>
    query
        .select({ generation: max(runtimePairing.generation) })
        .from(runtimePairing)
        .where(eq(runtimePairing.computerId, computerId));

/**
 * The generation whose daemon may act for the computer: the current one, once a daemon claimed it, until its access
 * ends. Every authorization of a Runtime credential or connection reads this one rule.
 */
export const activeGeneration = (computerId: ComputerReference) =>
    query
        .select({ generation: runtimeRegistration.generation })
        .from(runtimeRegistration)
        .where(
            and(
                inArray(runtimeRegistration.generation, currentGeneration(computerId)),
                notInArray(
                    runtimeRegistration.generation,
                    query.select({ generation: runtimeRevocation.generation }).from(runtimeRevocation),
                ),
            ),
        );
