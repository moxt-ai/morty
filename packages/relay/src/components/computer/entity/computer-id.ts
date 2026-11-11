import {
    ComputerManagementError,
    type ComputerManagementPlacement,
} from "../../management/entity/computer-management.ts";

const placements: ReadonlyMap<string, ComputerManagementPlacement> = new Map([
    ["wn", { locationHint: "wnam" }],
    ["en", { locationHint: "enam" }],
    ["sa", { locationHint: "sam" }],
    ["we", { locationHint: "weur" }],
    ["ee", { locationHint: "eeur" }],
    ["ap", { locationHint: "apac" }],
    ["an", { locationHint: "apac-ne" }],
    ["as", { locationHint: "apac-se" }],
    ["oc", { locationHint: "oc" }],
    ["af", { locationHint: "afr" }],
    ["me", { locationHint: "me" }],
]);

/** Relay IDs contain a locally mapped shard code followed by a 144-bit local identifier. */
export function encodeRelayComputerId(placement: ComputerManagementPlacement, localId: string): string {
    for (const [code, candidate] of placements) {
        if (candidate.locationHint === placement.locationHint) {
            return `prj_${code}_01_${localId}`;
        }
    }
    throw new ComputerManagementError(
        "storage_location_unavailable",
        "The requested storage location is unavailable",
        400,
    );
}

export function decodeComputerPlacement(computerId: string): ComputerManagementPlacement | null {
    const match = /^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_([A-Za-z0-9_-]{24})$/.exec(computerId);
    const code = match?.[1];
    if (match?.[0] !== computerId || code === undefined) {
        return null;
    }
    return placements.get(code) ?? null;
}

export function computerIdFromPrefixedValue(value: string): string | null {
    const match = /(?:^|_)(prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24})(?:[._]|$)/.exec(value);
    const computerId = match?.[1];
    return computerId !== undefined && decodeComputerPlacement(computerId) !== null ? computerId : null;
}
