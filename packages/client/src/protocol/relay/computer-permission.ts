export const COMPUTER_PERMISSION_NAMES = Object.freeze([
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:read",
    "session:write",
] as const);

export type ComputerPermissionName = (typeof COMPUTER_PERMISSION_NAMES)[number];

export const RELAY_COMPUTER_PERMISSIONS: readonly ComputerPermissionName[] = Object.freeze([
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:read",
    "session:write",
]);
