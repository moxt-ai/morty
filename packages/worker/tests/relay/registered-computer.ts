import { runInDurableObject } from "cloudflare:test";
import { holdsAccess } from "../../src/computer-relay/components/management/service/authentication-service.ts";
import { DurableComputerAccount } from "../../src/computer-relay/components/management/storage/durable-computer-account.ts";
import { IdentityStorage } from "../../src/computer-relay/components/management/storage/identity-storage.ts";
import { SqliteComputerManagementStore } from "../../src/computer-relay/components/management/storage/sqlite-computer-management-store.ts";
import { createRelayDurableObjectContext } from "../../src/computer-relay/composition/relay-durable-object-context.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import type { RelayBindings } from "../../src/contracts/relay-bindings.ts";

/** The computer's store as its ComputerRelay composes it, answering whose access holds from the computer's identities. */
export function computerManagementStore(computerId: string, storage: DurableObjectStorage) {
    return new SqliteComputerManagementStore(computerId, new DurableObjectDatabase(storage), async (holder, signal) =>
        holdsAccess(new IdentityStorage(new DurableObjectDatabase(storage), computerId), holder, signal),
    );
}

/** Seeds a committed revocation through the production store and applies it to the object's real connections. */
export async function revokeTestComputer(bindings: RelayBindings, computerId: string, signal: AbortSignal) {
    await runInDurableObject(bindings.COMPUTER_RELAY.getByName(computerId), async (_instance, state) => {
        const store = computerManagementStore(computerId, state.storage);
        await store.revokeComputer(
            {
                computerId,
                now: Date.now(),
                actorKind: "application",
                actorId: "test-owner",
                auditId: `test-revocation-${crypto.randomUUID()}`,
            },
            signal,
        );
        const runtime = createRelayDurableObjectContext(state, {
            accounts: new DurableComputerAccount(state.storage),
            database: new DurableObjectDatabase(state.storage),
            storeFor: () => store,
        });
        await runtime.services.runtime.revokeComputer(computerId, signal);
    });
}
