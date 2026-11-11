import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { holdsAccess } from "../../src/computer-relay/components/management/service/authentication-service.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { SqliteComputerManagementStore } from "../../src/computer-relay/components/management/storage/sqlite-computer-management-store.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { migrateComputerStorage } from "../../src/computer-relay/infra/migrate-computer-storage.ts";
import { computerPairing, computerRegistration } from "../../src/computer-relay/schema/pairing-do/index.ts";
import { computerDirectoryDrizzle } from "../../src/directory/storage/relay-drizzle-database.ts";
import { relayDrizzle } from "../../src/infra/drizzle-database.ts";
import { computerAccount } from "../../src/schema/d1/index.ts";
import { readComputerOwner } from "./directory-fixture.ts";

/** The computer's store as its ComputerRelay composes it, answering whose access holds from the computer's identities. */
export function computerManagementStore(computerId: string, storage: DurableObjectStorage) {
    return new SqliteComputerManagementStore(computerId, new DurableObjectDatabase(storage), async (holder, signal) =>
        holdsAccess(
            new IdentityStorage(
                new DurableObjectDatabase(storage),
                computerId,
                await readComputerOwner(env, computerId, signal),
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
        const database = relayDrizzle(new DurableObjectDatabase(state.storage), AbortSignal.timeout(10_000));
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
