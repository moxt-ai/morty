import type { HumanIdentity } from "@moxt-ai/app-slack-api/gateway";

export class StandaloneHumanIdentity implements HumanIdentity {
    readonly authenticateHuman: HumanIdentity["authenticateHuman"] = async (_authorization, signal) => {
        signal.throwIfAborted();
        return { kind: "human", humanId: "standalone", tenantId: "standalone", tenantSharding: null };
    };
}
