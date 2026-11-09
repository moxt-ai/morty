import { and, eq, isNull } from "drizzle-orm";
import type { ChannelCredentialIdentity } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelHostCredential, pairedDaemon, runtimeRegistration } from "../schema/project-do/index.ts";
import { hostCredentialValid } from "./host-credential-validity.ts";

/** Whether a Runtime, or a host credential reaching it, is still active in the Project's own storage. */
export class ChannelCredentialStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readActiveRuntime = async (
        identity: { readonly computerId: string },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const runtimes = await database
            .select({ computerId: pairedDaemon.computerId })
            .from(pairedDaemon)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
            .where(
                and(
                    eq(pairedDaemon.computerId, identity.computerId),
                    eq(pairedDaemon.computerId, identity.computerId),
                    isNull(pairedDaemon.revokedAt),
                ),
            )
            .limit(1);
        return runtimes.length === 1;
    };

    readonly readActive = async (identity: ChannelCredentialIdentity, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const credentials = await database
            .select({ credentialId: channelHostCredential.credentialId })
            .from(channelHostCredential)
            .innerJoin(pairedDaemon, eq(pairedDaemon.computerId, channelHostCredential.computerId))
            .where(
                and(
                    eq(channelHostCredential.credentialId, identity.credentialId),
                    eq(channelHostCredential.computerId, identity.computerId),
                    eq(pairedDaemon.computerId, identity.computerId),
                    eq(pairedDaemon.computerId, identity.computerId),
                    hostCredentialValid(database),
                ),
            )
            .limit(1);
        return credentials.length === 1;
    };
}
