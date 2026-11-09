import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { validateIdentifier } from "../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type { PairingScopeRow } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { computer, daemonCredential, runtimePairingRequest } from "../schema/project-do/index.ts";

/** The Projects in this storage whose credential matches. */
export async function credentialMatches(
    database: SqlDatabase,
    credential: ComputerIdentityCredential,
    signal: AbortSignal,
): Promise<readonly PairingScopeRow[]> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "daemon":
            return orm
                .select({ computer_id: computer.computerId })
                .from(computer)
                .innerJoin(daemonCredential, eq(daemonCredential.computerId, computer.computerId))
                .where(
                    and(
                        eq(computer.computerId, validateIdentifier(credential.computerId, "computer_id")),
                        eq(daemonCredential.tokenHash, credential.tokenHash),
                        isNotNull(computer.claimedAt),
                        isNull(computer.revokedAt),
                    ),
                );
        case "pairing":
            return orm
                .select({ computer_id: computer.computerId })
                .from(runtimePairingRequest)
                .innerJoin(computer, eq(computer.computerId, runtimePairingRequest.computerId))
                .where(
                    and(
                        eq(runtimePairingRequest.computerId, validateIdentifier(credential.computerId, "computer_id")),
                        eq(runtimePairingRequest.pollTokenHash, credential.tokenHash),
                    ),
                );
        case "pairing-code":
            return orm
                .select({ computer_id: computer.computerId })
                .from(runtimePairingRequest)
                .innerJoin(computer, eq(computer.computerId, runtimePairingRequest.computerId))
                .where(eq(runtimePairingRequest.pairingCodeHash, credential.codeHash));
    }
}
