import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { validateIdentifier } from "../entity/pairing/pairing.ts";
import type { ComputerIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type { CredentialMatch } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    channelAccessGrant,
    channelHostCredential,
    computer,
    daemonCredential,
    projectBrowserCredential,
    runtimePairingRequest,
} from "../schema/project-do/index.ts";
import { hostCredentialValid } from "./host-credential-validity.ts";

/** The Projects in this storage whose credential matches; only browser credentials carry their own lifetime. */
export async function credentialMatches(
    database: SqlDatabase,
    credential: ComputerIdentityCredential,
    signal: AbortSignal,
): Promise<readonly CredentialMatch[]> {
    if (credential.kind !== "project") {
        const rows = await credentialRows(database, credential, signal);
        return rows.map((row) => ({ computer_id: row.computer_id, expires_at: null, revoked_at: null }));
    }
    const orm = relayDrizzle(database, signal);
    const computerId = validateIdentifier(credential.computerId, "computer_id");
    const [hosts, browsers] = await Promise.all([
        orm
            .select({ computer_id: computer.computerId })
            .from(channelHostCredential)
            .innerJoin(computer, eq(computer.computerId, channelHostCredential.computerId))
            .where(
                and(
                    eq(computer.computerId, computerId),
                    eq(channelHostCredential.tokenHash, credential.tokenHash),
                    hostCredentialValid(orm),
                ),
            ),
        orm
            .select({
                computer_id: projectBrowserCredential.computerId,
                expires_at: projectBrowserCredential.expiresAt,
                revoked_at: projectBrowserCredential.revokedAt,
            })
            .from(projectBrowserCredential)
            .where(
                and(
                    eq(projectBrowserCredential.computerId, computerId),
                    eq(projectBrowserCredential.tokenHash, credential.tokenHash),
                ),
            ),
    ]);
    return [...hosts.map((row) => ({ computer_id: row.computer_id, expires_at: null, revoked_at: null })), ...browsers];
}

async function credentialRows(
    database: SqlDatabase,
    credential: Exclude<ComputerIdentityCredential, { readonly kind: "project" }>,
    signal: AbortSignal,
): Promise<readonly { readonly computer_id: string }[]> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "host":
            return orm
                .select({ computer_id: computer.computerId })
                .from(channelHostCredential)
                .innerJoin(computer, eq(computer.computerId, channelHostCredential.computerId))
                .where(
                    and(
                        eq(channelHostCredential.computerId, validateIdentifier(credential.computerId, "computer_id")),
                        eq(channelHostCredential.tokenHash, credential.tokenHash),
                        hostCredentialValid(orm),
                    ),
                );
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
        case "grant":
            return orm
                .select({ computer_id: computer.computerId })
                .from(channelAccessGrant)
                .innerJoin(computer, eq(computer.computerId, channelAccessGrant.computerId))
                .where(
                    and(
                        eq(channelAccessGrant.computerId, validateIdentifier(credential.computerId, "computer_id")),
                        eq(channelAccessGrant.grantId, validateIdentifier(credential.grantId, "grant_id")),
                        eq(channelAccessGrant.secretHash, credential.secretHash),
                    ),
                );
    }
}
