import type { ProjectLocationHint } from "@morty-build/client/protocol";
import { PlatformControlPlaneError, type PlatformProjectPlacement } from "./platform-control-plane.ts";

const placements: ReadonlyMap<string, PlatformProjectPlacement> = new Map([
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

/** Platform IDs contain a locally mapped shard code followed by a 144-bit local identifier. */
export function encodePlatformAccountId(placement: PlatformProjectPlacement, localId: string): string {
    for (const [code, candidate] of placements) {
        if (candidate.locationHint === placement.locationHint) {
            return `prj_${code}_01_${localId}`;
        }
    }
    throw new PlatformControlPlaneError(
        "storage_location_unavailable",
        "The requested storage location is unavailable",
        400,
    );
}

export function decodeAccountPlacement(accountId: string): PlatformProjectPlacement | null {
    const match = /^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_([A-Za-z0-9_-]{24})$/.exec(accountId);
    const code = match?.[1];
    if (match?.[0] !== accountId || code === undefined) {
        return null;
    }
    return placements.get(code) ?? null;
}

export function projectBucketLocation(locationHint: ProjectLocationHint): "apac" | "wnam" {
    return locationHint === "apac" || locationHint === "apac-ne" || locationHint === "apac-se" || locationHint === "oc"
        ? "apac"
        : "wnam";
}

export function accountIdFromPrefixedValue(value: string): string | null {
    const match = /(?:^|_)(prj_(?:wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24})(?:[._]|$)/.exec(value);
    const accountId = match?.[1];
    return accountId !== undefined && decodeAccountPlacement(accountId) !== null ? accountId : null;
}
