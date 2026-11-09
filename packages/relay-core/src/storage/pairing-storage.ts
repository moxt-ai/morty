import { and, desc, eq, exists, gt, isNull, sql } from "drizzle-orm";
import type { AuthorizedChannelRow, LinkedDeviceRow } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    channelAccessGrant,
    channelHostCredential,
    pairedDaemon,
    projectBrowserCredential,
} from "../schema/project-do/index.ts";
import { hostCredentialValid } from "./host-credential-validity.ts";

/** Host, access grant and browser credentials in the Project's own storage. */
export class PairingStorage {
    readonly #database: SqlDatabase;
    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readHost = async (
        channelId: string,
        tokenHash: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const rows = await database
            .select({
                channel_id: pairedDaemon.channelId,
                pairing_id: pairedDaemon.pairingId,
                project_id: pairedDaemon.computerId,
                credential_id: channelHostCredential.credentialId,
                authority: channelHostCredential.authority,
            })
            .from(channelHostCredential)
            .innerJoin(pairedDaemon, eq(pairedDaemon.channelId, channelHostCredential.channelId))
            .where(
                and(
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.tokenHash, tokenHash),
                    hostCredentialValid(database),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    /** Records use of a host credential; false when it no longer authenticates. */
    readonly touchHost = async (credentialId: string, now: number, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const touched = await database
            .update(channelHostCredential)
            .set({ lastUsedAt: now })
            .where(and(eq(channelHostCredential.credentialId, credentialId), hostCredentialValid(database)))
            .returning({ credentialId: channelHostCredential.credentialId });
        return touched.length === 1;
    };

    /** Records a single-use access grant; false when it was not recorded. */
    readonly createGrant = async (
        grantId: string,
        channelId: string,
        secretHash: string,
        credentialId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const created = await relayDrizzle(this.#database, signal)
            .insert(channelAccessGrant)
            .values({ grantId, channelId, secretHash, createdByCredentialId: credentialId, createdAt: now, expiresAt })
            .returning({ grantId: channelAccessGrant.grantId });
        return created.length === 1;
    };

    /** Records a browser credential issued by `ownerId`; false when it was not recorded. */
    readonly createBrowser = async (
        credentialId: string,
        computerId: string,
        tokenHash: string,
        ownerId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const created = await relayDrizzle(this.#database, signal)
            .insert(projectBrowserCredential)
            .values({
                credentialId,
                computerId,
                tokenHash,
                createdByCredentialId: ownerId,
                createdAt: now,
                expiresAt,
                lastUsedAt: now,
            })
            .returning({ credentialId: projectBrowserCredential.credentialId });
        return created.length === 1;
    };

    readonly listLinked = async (channelId: string, signal: AbortSignal): Promise<readonly LinkedDeviceRow[]> => {
        const database = relayDrizzle(this.#database, signal);
        return await database
            .select({
                credential_id: channelHostCredential.credentialId,
                created_at: channelHostCredential.createdAt,
                last_used_at: channelHostCredential.lastUsedAt,
            })
            .from(channelHostCredential)
            .where(
                and(
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.authority, "linked"),
                    hostCredentialValid(database),
                ),
            )
            .orderBy(desc(channelHostCredential.createdAt), desc(channelHostCredential.credentialId));
    };

    readonly redeemGrant = (
        channelId: string,
        grantId: string,
        secretHash: string,
        credentialId: string,
        hostHash: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const database = relayDrizzle(this.#database, signal);
        const grant = and(eq(channelAccessGrant.grantId, grantId), eq(channelAccessGrant.channelId, channelId));
        const redemption = database
            .update(channelAccessGrant)
            .set({ redeemedAt: now, redeemedCredentialId: credentialId })
            .where(
                and(
                    grant,
                    eq(channelAccessGrant.secretHash, secretHash),
                    isNull(channelAccessGrant.redeemedAt),
                    gt(channelAccessGrant.expiresAt, now),
                    exists(
                        database
                            .select({ pairingId: pairedDaemon.pairingId })
                            .from(pairedDaemon)
                            .where(
                                and(
                                    eq(pairedDaemon.channelId, channelAccessGrant.channelId),
                                    isNull(pairedDaemon.revokedAt),
                                ),
                            ),
                    ),
                ),
            );
        const credential = database.insert(channelHostCredential).select(
            database
                .select({
                    credentialId: sql<string>`${credentialId}`.as("credential_id"),
                    channelId: channelAccessGrant.channelId,
                    tokenHash: sql<string>`${hostHash}`.as("token_hash"),
                    authority: sql<"linked">`'linked'`.as("authority"),
                    createdAt: sql<number>`${now}`.as("created_at"),
                    lastUsedAt: sql<number>`${now}`.as("last_used_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    sourceGrantId: channelAccessGrant.grantId,
                })
                .from(channelAccessGrant)
                .where(
                    and(
                        grant,
                        eq(channelAccessGrant.redeemedAt, now),
                        eq(channelAccessGrant.redeemedCredentialId, credentialId),
                    ),
                ),
        );
        // Authorization and consumption share the credential-issuance transaction.
        return this.#database.batch(
            [redemption, credential].map((query) => {
                const { sql, params } = query.toSQL();
                return this.#database.prepare(sql).bind(...params);
            }),
            signal,
        );
    };

    readonly readGrant = async (channelId: string, grantId: string, secretHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                expires_at: channelAccessGrant.expiresAt,
                redeemed_at: channelAccessGrant.redeemedAt,
                runtime_revoked_at: pairedDaemon.revokedAt,
            })
            .from(channelAccessGrant)
            .innerJoin(pairedDaemon, eq(pairedDaemon.channelId, channelAccessGrant.channelId))
            .where(
                and(
                    eq(channelAccessGrant.grantId, grantId),
                    eq(channelAccessGrant.channelId, channelId),
                    eq(channelAccessGrant.secretHash, secretHash),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    /** Revokes an active linked device; false when no active linked device matched. */
    readonly revokeLinked = async (
        channelId: string,
        credentialId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const revoked = await relayDrizzle(this.#database, signal)
            .update(channelHostCredential)
            .set({ revokedAt: now })
            .where(
                and(
                    eq(channelHostCredential.credentialId, credentialId),
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.authority, "linked"),
                    isNull(channelHostCredential.revokedAt),
                ),
            )
            .returning({ credentialId: channelHostCredential.credentialId });
        return revoked.length === 1;
    };

    /** Whether the linked device exists, revoked or not. */
    readonly hasLinked = async (channelId: string, credentialId: string, signal: AbortSignal): Promise<boolean> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ credentialId: channelHostCredential.credentialId })
            .from(channelHostCredential)
            .where(
                and(
                    eq(channelHostCredential.credentialId, credentialId),
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.authority, "linked"),
                ),
            )
            .limit(1);
        return rows.length === 1;
    };

    /** Revokes a browser credential of the Project, keeping its first revocation time; false when none matched. */
    readonly revokeBrowser = async (
        computerId: string,
        credentialId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const revoked = await relayDrizzle(this.#database, signal)
            .update(projectBrowserCredential)
            .set({ revokedAt: sql`coalesce(${projectBrowserCredential.revokedAt}, ${now})` })
            .where(
                and(
                    eq(projectBrowserCredential.credentialId, credentialId),
                    eq(projectBrowserCredential.computerId, computerId),
                ),
            )
            .returning({ credentialId: projectBrowserCredential.credentialId });
        return revoked.length === 1;
    };
}
