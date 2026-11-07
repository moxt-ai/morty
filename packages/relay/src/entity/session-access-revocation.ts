/** Workers that issue and verify Session credentials keep their own clocks; a revocation covers their skew. */
const SESSION_ACCESS_REVOCATION_CLOCK_MARGIN_MILLISECONDS = 5_000;

/** The latest issue time of the Session credentials that a revocation recorded at `revokedAt` revokes. */
export const sessionAccessRevokedThrough = (revokedAt: number): number =>
    revokedAt + SESSION_ACCESS_REVOCATION_CLOCK_MARGIN_MILLISECONDS;
