export const COMPUTER_INTERNAL_PREFIX = "/__computer/computers";
export const computerAccountPath = (computerId: string): string =>
    `${COMPUTER_INTERNAL_PREFIX}/${encodeURIComponent(computerId)}/account`;
