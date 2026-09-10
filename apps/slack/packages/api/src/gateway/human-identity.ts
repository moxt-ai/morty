import type { HumanPrincipal } from "../service/identity/identity-service";

/** The embedding host verifies credentials and resolves workspace membership and placement. */
export interface HumanIdentity {
    readonly authenticateHuman: (authorization: string | null, signal: AbortSignal) => Promise<HumanPrincipal>;
}
