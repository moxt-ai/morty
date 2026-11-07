import type { DoSqlDatabase } from "@morty-build/relay-core/database";
import { pairingChannel } from "../schema/legacy-project-do/pairing-channel.ts";

class RetiredPairingStateError extends Error {
    readonly code = "retired_pairing_state";

    constructor() {
        super("Retained pairing records require a fresh Morty installation; the original records remain untouched");
        this.name = "RetiredPairingStateError";
    }
}

// Check before the immutable DROP migration. Retired records stay in their original
// table; current installations never convert them or inherit their credentials.
export function rejectRetiredPairingRecords(database: DoSqlDatabase): void {
    if (
        database.orm.select({ pairingId: pairingChannel.pairingId }).from(pairingChannel).limit(1).get() !== undefined
    ) {
        throw new RetiredPairingStateError();
    }
}
