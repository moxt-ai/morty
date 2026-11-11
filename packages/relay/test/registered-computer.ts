import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { holdsAccess } from "../../worker/src/components/management/service/authentication-service.ts";
import { IdentityStorage } from "../../worker/src/components/management/storage/identity-storage.ts";
import { createHostedRelayAccess } from "../../worker/src/composition/relay-services.ts";
import { DurableObjectDatabase } from "../../worker/src/infra/durable-object-database.ts";
import { migrateComputerStorage } from "../src/components/computer/migrate-computer-storage.ts";
import { computerDirectoryDrizzle } from "../src/components/management/storage/relay-drizzle-database.ts";
import { SqliteComputerManagementStore } from "../src/components/management/storage/sqlite-computer-management-store.ts";
import { relayDrizzle } from "../src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../src/infra/durable-object-sql-database.ts";
import { computerPairing, computerRegistration } from "../src/schema/computer-relay-do/index.ts";
import { computerAccount } from "../src/schema/d1/index.ts";

/** The computer's store as its ComputerRelay composes it, answering whose access holds from the computer's identities. */
export function computerManagementStore(computerId: string, storage: DurableObjectStorage) {
    return new SqliteComputerManagementStore(
        computerId,
        new DurableObjectDatabaseAdapter(storage),
        async (holder, signal) =>
            holdsAccess(
                new IdentityStorage(
                    new DurableObjectDatabase(storage),
                    computerId,
                    await createHostedRelayAccess(env).control.readComputerOwner(computerId, signal),
                ),
                holder,
                signal,
            ),
    );
}

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime in an active Project. */
export async function registerComputerFixture(computerId: string): Promise<void> {
    const registeredAt = Date.UTC(2026, 9, 27);
    const userId = `user_${computerId}`;
    const directory = computerDirectoryDrizzle(env.RELAY_DIRECTORY_DATABASE);
    await directory.batch([
        directory
            .insert(computerAccount)
            .values({
                computerId,
                userId,
                displayName: "Registered test Project",
                clientReference: computerId,
                idempotencyKey: computerId,
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
    ]);
    await runInDurableObject(env.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        migrateComputerStorage(state.storage);
        const database = relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000));
        const [pairing] = await database
            .insert(computerPairing)
            .values({
                computerId,
                pairingCodeHash: `fixture-code-${computerId}`,
                pollTokenHash: `fixture-poll-${computerId}`,
                expiresAt: registeredAt,
                creationIdempotencyKey: `fixture-${computerId}`,
                createdByOwnerCredentialId: `fixture-owner-${computerId}`,
            })
            .onConflictDoNothing()
            .returning({ generation: computerPairing.generation });
        if (pairing !== undefined) {
            await database.insert(computerRegistration).values({
                generation: pairing.generation,
                claimedAt: registeredAt,
                computerName: "Registered test Runtime",
                workspaceName: "Registered test workspace",
                agentsJson: "[]",
            });
        }
    });
}
