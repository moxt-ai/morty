import { and, eq, isNull } from "drizzle-orm";
import { validateIdentifier } from "../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type { CredentialMatch } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    channelAccessGrant,
    channelHostCredential,
    projectBrowserCredential,
    runtimeDaemonCredential,
    runtimeIdentity,
    runtimePairingRequest,
    runtimeRegistration,
} from "../schema/project-do/index.ts";
import { hostCredentialValid } from "./host-credential-validity.ts";

/** The Projects in this storage whose credential matches; only browser credentials carry their own lifetime. */
export async function credentialMatches(
    database: SqlDatabase,
    credential: PairingIdentityCredential,
    signal: AbortSignal,
): Promise<readonly CredentialMatch[]> {
    if (credential.kind !== "project") {
        const rows = await credentialRows(database, credential, signal);
        return rows.map((row) => ({ project_id: row.project_id, expires_at: null, revoked_at: null }));
    }
    const orm = relayDrizzle(database, signal);
    const computerId = validateIdentifier(credential.computerId, "project_id");
    const [hosts, browsers] = await Promise.all([
        orm
            .select({ project_id: runtimeIdentity.computerId })
            .from(channelHostCredential)
            .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelHostCredential.channelId))
            .where(
                and(
                    eq(runtimeIdentity.computerId, computerId),
                    eq(channelHostCredential.tokenHash, credential.tokenHash),
                    hostCredentialValid(orm),
                ),
            ),
        orm
            .select({
                project_id: projectBrowserCredential.computerId,
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
    return [...hosts.map((row) => ({ project_id: row.project_id, expires_at: null, revoked_at: null })), ...browsers];
}

async function credentialRows(
    database: SqlDatabase,
    credential: Exclude<PairingIdentityCredential, { readonly kind: "project" }>,
    signal: AbortSignal,
): Promise<readonly { readonly project_id: string }[]> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "host":
            return orm
                .select({ project_id: runtimeIdentity.computerId })
                .from(channelHostCredential)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelHostCredential.channelId))
                .where(
                    and(
                        eq(channelHostCredential.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(channelHostCredential.tokenHash, credential.tokenHash),
                        hostCredentialValid(orm),
                    ),
                );
        case "daemon":
            return orm
                .select({ project_id: runtimeIdentity.computerId })
                .from(runtimeIdentity)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.runtimeId, runtimeIdentity.runtimeId))
                .where(
                    and(
                        eq(runtimeIdentity.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(runtimeDaemonCredential.tokenHash, credential.tokenHash),
                        isNull(runtimeIdentity.revokedAt),
                    ),
                );
        case "pairing":
            return orm
                .select({ project_id: runtimeIdentity.computerId })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(
                    and(
                        eq(runtimePairingRequest.pairingId, validateIdentifier(credential.pairingId, "pairing_id")),
                        eq(runtimePairingRequest.pollTokenHash, credential.tokenHash),
                    ),
                );
        case "pairing-code":
            return orm
                .select({ project_id: runtimeIdentity.computerId })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(eq(runtimePairingRequest.pairingCodeHash, credential.codeHash));
        case "grant":
            return orm
                .select({ project_id: runtimeIdentity.computerId })
                .from(channelAccessGrant)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelAccessGrant.channelId))
                .where(
                    and(
                        eq(channelAccessGrant.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(channelAccessGrant.grantId, validateIdentifier(credential.grantId, "grant_id")),
                        eq(channelAccessGrant.secretHash, credential.secretHash),
                    ),
                );
    }
}
