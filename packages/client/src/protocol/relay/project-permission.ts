export const PROJECT_PERMISSION_NAMES = Object.freeze([
    "computer:pair",
    "computer:read",
    "computer:revoke",
    "session:read",
    "session:write",
] as const);

export type ProjectPermissionName = (typeof PROJECT_PERMISSION_NAMES)[number];

export const RELAY_APP_PROJECT_PERMISSIONS: readonly ProjectPermissionName[] = Object.freeze([
    "computer:pair",
    "computer:read",
    "computer:revoke",
    "session:read",
    "session:write",
]);
