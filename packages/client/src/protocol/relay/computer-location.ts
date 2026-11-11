export const COMPUTER_LOCATION_HINTS: readonly [
    "wnam",
    "enam",
    "sam",
    "weur",
    "eeur",
    "apac",
    "apac-ne",
    "apac-se",
    "oc",
    "afr",
    "me",
] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"];

export type ComputerLocationHint = (typeof COMPUTER_LOCATION_HINTS)[number];

const computerLocationHints: ReadonlySet<unknown> = new Set(COMPUTER_LOCATION_HINTS);

export function isComputerLocationHint(value: unknown): value is ComputerLocationHint {
    return computerLocationHints.has(value);
}
