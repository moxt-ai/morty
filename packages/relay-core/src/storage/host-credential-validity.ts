import { and, eq, exists, isNull, type SQL } from "drizzle-orm";
import type { RelayDrizzleDatabase } from "../infra/drizzle-database.ts";
import { channelHostCredential, pairedDaemon, runtimeRegistration } from "../schema/project-do/index.ts";

/**
 * Whether the `channel_host_credentials` row in scope authenticates now. A host credential authenticates while it is
 * unrevoked and its Runtime is registered and unrevoked. Revoking a Runtime does not write its host credentials, so
 * their access derives from the Runtime. Every host-credential reader filters through this one rule.
 */
export function hostCredentialValid(database: RelayDrizzleDatabase): SQL | undefined {
    return and(
        isNull(channelHostCredential.revokedAt),
        exists(
            database
                .select({ computerId: pairedDaemon.computerId })
                .from(pairedDaemon)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.computerId, pairedDaemon.computerId))
                .where(
                    and(eq(pairedDaemon.computerId, channelHostCredential.computerId), isNull(pairedDaemon.revokedAt)),
                ),
        ),
    );
}
