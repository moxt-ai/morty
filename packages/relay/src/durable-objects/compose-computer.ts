import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { DurableObjectDatabaseAdapter } from "@morty-build/relay-core";
import type { ComputerManagementStore } from "../infra/computer-management-store.ts";
import type { ComputerSessionAccess } from "../infra/computer-session-access.ts";
import { computerSessionAccess } from "../service/computer-session-access.ts";
import { SqliteComputerManagementStore } from "../storage/sqlite-computer-management-store.ts";

/** One computer's store and Session access over the storage its ComputerRelay owns. */
export function composeComputer(
    computerId: string,
    storage: DurableObjectStorage,
    identities: {
        readonly holdsAccess: (
            computerId: string,
            holder: SessionAccessHolder,
            signal: AbortSignal,
        ) => Promise<boolean>;
    },
): { readonly store: ComputerManagementStore; readonly sessionAccess: ComputerSessionAccess } {
    const store = new SqliteComputerManagementStore(computerId, new DurableObjectDatabaseAdapter(storage));
    return {
        store,
        sessionAccess: computerSessionAccess({
            holdsAccess: (holder, signal) => identities.holdsAccess(computerId, holder, signal),
            activeGeneration: (signal) => store.readActiveGeneration(computerId, signal),
        }),
    };
}
