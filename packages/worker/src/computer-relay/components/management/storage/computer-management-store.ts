import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { ComputerRelayStore } from "./computer-relay-store.ts";

/** Identity operations in the owning ComputerRelay storage. */
export interface ComputerManagementStore extends ComputerRelayStore {
    /**
     * Whether `holder`'s access to the computer holds now, read from the computer's identities. A Session credential
     * carrying that access is issued and honored only while it does.
     */
    readonly holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>;
}
