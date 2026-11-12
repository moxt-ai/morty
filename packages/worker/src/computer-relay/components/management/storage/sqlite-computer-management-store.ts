import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import type { ComputerManagementStore } from "./computer-management-store.ts";
import { SqliteComputerRelayStore } from "./sqlite-computer-relay-store.ts";

/**
 * Identity operations over one computer's SQLite storage. Only its ComputerRelay
 * constructs this; callers use the object's operations.
 */
export class SqliteComputerManagementStore extends SqliteComputerRelayStore implements ComputerManagementStore {
    /** `holdsAccess` answers, from the computer's identities, whether a holder's access to the computer still holds. */
    constructor(
        computerId: string,
        database: DurableObjectDatabase,
        holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>,
    ) {
        super(computerId, database);
        this.holdsAccess = holdsAccess;
    }

    readonly holdsAccess: ComputerManagementStore["holdsAccess"];
}
