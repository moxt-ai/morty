import type { SessionAccessHolder } from "@morty-build/client/protocol";

/** One computer's current answer for the access Session credentials carry. */
export interface ComputerSessionAccess {
    /**
     * The Runtime pairing generation a Session credential carrying `holder`'s access is issued and honored under now:
     * the computer's active generation while the holder's access to the computer holds; null when either has ended.
     */
    readonly currentGeneration: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<number | null>;
}

/** Locates each computer's Session access. */
export interface ComputerSessionAccessDirectory {
    readonly forComputer: (computerId: string) => ComputerSessionAccess;
}
