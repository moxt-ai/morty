import { and, eq, inArray } from "drizzle-orm";
import { relayDrizzle } from "../../../infra/drizzle-database.ts";
import type { SqlDatabase } from "../../../infra/sql-database.ts";
import { daemonCredential, runtimePairing } from "../../../schema/project-do/index.ts";
import { validateIdentifier } from "../entity/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing-identity.ts";
import type { PairingScopeRow } from "../entity/pairing-records.ts";
import { activeGeneration, currentGeneration } from "./runtime-generation.ts";

/** The Projects in this storage whose credential matches. */
export async function credentialMatches(
    database: SqlDatabase,
    credential: ComputerIdentityCredential,
    signal: AbortSignal,
): Promise<readonly PairingScopeRow[]> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "daemon": {
            const computerId = validateIdentifier(credential.computerId, "computer_id");
            return orm
                .select({ computer_id: runtimePairing.computerId })
                .from(daemonCredential)
                .innerJoin(runtimePairing, eq(runtimePairing.generation, daemonCredential.generation))
                .where(
                    and(
                        eq(runtimePairing.computerId, computerId),
                        eq(daemonCredential.tokenHash, credential.tokenHash),
                        inArray(daemonCredential.generation, activeGeneration(computerId)),
                    ),
                );
        }
        case "pairing": {
            // Only the current generation's poll token reads the computer's pairing.
            const computerId = validateIdentifier(credential.computerId, "computer_id");
            return orm
                .select({ computer_id: runtimePairing.computerId })
                .from(runtimePairing)
                .where(
                    and(
                        eq(runtimePairing.computerId, computerId),
                        eq(runtimePairing.pollTokenHash, credential.tokenHash),
                        inArray(runtimePairing.generation, currentGeneration(computerId)),
                    ),
                );
        }
        case "pairing-code":
            return orm
                .select({ computer_id: runtimePairing.computerId })
                .from(runtimePairing)
                .where(eq(runtimePairing.pairingCodeHash, credential.codeHash));
    }
}
