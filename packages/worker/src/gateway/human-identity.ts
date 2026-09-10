import type { HumanPrincipal } from "../components/slack/service/identity/identity-service";

/** The embedding host verifies a user credential and supplies that user's storage identity. */
export interface HumanIdentity {
    readonly authenticateHuman: (authorization: string | null, signal: AbortSignal) => Promise<HumanPrincipal>;
}
