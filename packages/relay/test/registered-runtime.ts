import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../../relay-core/src/infra/durable-object-sql-database.ts";
import { computer } from "../../relay-core/src/schema/project-do/index.ts";
import { migrateComputerStorage } from "../src/durable-objects/migrate-computer-storage.ts";
import { machineAccount } from "../src/schema/d1/index.ts";
import { computerDirectoryDrizzle } from "../src/storage/relay-drizzle-database.ts";

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime in an active Project. */
export async function registerRuntimeFixture(computerId: string): Promise<void> {
    const registeredAt = Date.UTC(2026, 9, 27);
    const userId = `user_${computerId}`;
    const directory = computerDirectoryDrizzle(env.RELAY_DIRECTORY_DATABASE);
    await directory.batch([
        directory
            .insert(machineAccount)
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
        await database.batch([
            database
                .insert(computer)
                .values({
                    computerId,
                    createdAt: registeredAt,
                    claimedAt: registeredAt,
                    machineName: "Registered test Runtime",
                    workspaceName: "Registered test workspace",
                    agentsJson: "[]",
                })
                .onConflictDoNothing(),
        ]);
    });
}
