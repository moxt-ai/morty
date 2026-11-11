import { and, eq, inArray } from "drizzle-orm";
import { relayDrizzle } from "../../../infra/drizzle-database.ts";
import type { SqlDatabase } from "../../../infra/sql-database.ts";
import { computerPairing, daemonCredential } from "../../../schema/computer-relay-do/index.ts";
import { validateIdentifier } from "../entity/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing-identity.ts";
import type { PairingScopeRow } from "../entity/pairing-records.ts";
import { activeGeneration } from "./computer-generation.ts";

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
                .select({ computer_id: computerPairing.computerId })
                .from(daemonCredential)
                .innerJoin(computerPairing, eq(computerPairing.generation, daemonCredential.generation))
                .where(
                    and(
                        eq(computerPairing.computerId, computerId),
                        eq(daemonCredential.tokenHash, credential.tokenHash),
                        inArray(daemonCredential.generation, activeGeneration(computerId)),
                    ),
                );
        }
        case "pairing-code":
            return orm
                .select({ computer_id: computerPairing.computerId })
                .from(computerPairing)
                .where(eq(computerPairing.pairingCodeHash, credential.codeHash));
    }
}
