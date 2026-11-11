export const PROJECT_LOCATION_HINTS: readonly ["wnam", "apac", "apac-ne", "apac-se"] = [
    "wnam",
    "apac",
    "apac-ne",
    "apac-se",
];

export type ProjectLocationHint = (typeof PROJECT_LOCATION_HINTS)[number];
