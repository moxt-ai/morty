export const PROJECT_LOCATION_HINTS: readonly [
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

export type ProjectLocationHint = (typeof PROJECT_LOCATION_HINTS)[number];
