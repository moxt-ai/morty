import type { HumanIdentity } from "@moxt-ai/app-slack-api/gateway";
import { IdentityError } from "../../../../apps/slack/packages/api/src/service/identity/identity-service.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { ConfigurationStorage } from "../storage/configuration-storage.ts";
import { ClerkGateway } from "./clerk-gateway.ts";
import { CloudTenantShardingDirectory } from "./cloud-tenant-sharding-directory.ts";

export class CloudSlackHumanIdentity implements HumanIdentity {
    readonly #configuration: ConfigurationStorage;
    readonly #clerk: ClerkGateway;
    readonly #tenants: CloudTenantShardingDirectory;

    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#configuration = new ConfigurationStorage(cx);
        this.#clerk = new ClerkGateway(cx);
        this.#tenants = new CloudTenantShardingDirectory(cx);
    }

    readonly authenticateHuman: HumanIdentity["authenticateHuman"] = async (authorization, signal) => {
        const configuration = this.#configuration.read();
        if (configuration === null || authorization === null || !/^Bearer [^ ]+$/u.test(authorization)) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Workspace authentication is required");
        }
        const session = await this.#clerk.verify(authorization.slice(7), configuration, signal);
        if (session === null) {
            throw new IdentityError("AUTHENTICATION_FAILED", "Workspace authentication failed");
        }
        if (session.organizationId === null) {
            throw new IdentityError("AUTHORIZATION_FAILED", "Select a workspace to manage Slack");
        }
        const placement = session.placement;
        const tenant = placement === null ? await this.#tenants.resolve(session.organizationId, signal) : null;
        return {
            kind: "human",
            humanId: session.userId,
            tenantId: session.organizationId,
            tenantSharding: placement ?? (tenant?.tenantSharding.hasShard ? tenant.tenantSharding.shard : null),
        };
    };
}
