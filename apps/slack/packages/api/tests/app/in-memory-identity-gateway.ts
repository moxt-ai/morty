import * as v from "valibot";
import { IdentityGateway } from "../../src/gateway/index";

export class InMemoryIdentityGateway extends IdentityGateway {
    readonly bots = new Set(["tenant-1:bot-1", "tenant-1:bot-source"]);
    constructor() {
        super({ config: { serviceToken: "test-service-token" } });
    }
    override readonly request = async (url: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        if (url.endsWith("/credentials/verify")) {
            const credential = v.parse(v.object({ authorization: v.string() }), body).authorization;
            if (credential !== "test-bot") {
                throw new Error("Invalid bot credential");
            }
            return { kind: "agent", tenantId: "tenant-1", agentId: "bot-1" };
        }
        const input = v.parse(
            v.object({
                tenantId: v.string(),
                agentId: v.optional(v.string()),
                targetAgentId: v.optional(v.string()),
            }),
            body,
        );
        return {
            allowed: this.bots.has(`${input.tenantId}:${input.agentId ?? input.targetAgentId}`),
        };
    };
}
