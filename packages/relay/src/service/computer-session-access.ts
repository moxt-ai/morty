import type { SessionAccessHolder } from "@morty-build/client/protocol";
import type { ComputerSessionAccess } from "../infra/computer-session-access.ts";

/**
 * A computer's Session access from what owns each half of it: the computer's identities, which decide whether a
 * holder's access holds, and its Runtime pairing, which names the active generation.
 */
export function computerSessionAccess(sources: {
    readonly holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>;
    readonly activeGeneration: (signal: AbortSignal) => Promise<number | null>;
}): ComputerSessionAccess {
    return {
        currentGeneration: async (holder, signal) => {
            const [holds, generation] = await Promise.all([
                sources.holdsAccess(holder, signal),
                sources.activeGeneration(signal),
            ]);
            return holds ? generation : null;
        },
    };
}
