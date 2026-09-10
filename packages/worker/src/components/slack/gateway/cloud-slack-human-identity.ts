import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { ClerkGateway } from "../../cloud/gateway/clerk-gateway.ts";
import { ConfigurationStorage } from "../../cloud/storage/configuration-storage.ts";
import { IdentityError } from "../service/identity/identity-service.ts";
import type { HumanIdentity } from "./human-identity.ts";

export class CloudSlackHumanIdentity implements HumanIdentity {
    readonly #configuration: ConfigurationStorage;
    readonly #clerk: ClerkGateway;
    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#configuration = new ConfigurationStorage(cx);
        this.#clerk = new ClerkGateway();
    }
    readonly authenticateHuman: HumanIdentity["authenticateHuman"] = async (authorization, signal) => {
        const configuration = this.#configuration.read();
        if (configuration === null || authorization === null || !/^Bearer [^ ]+$/u.test(authorization)) {
            throw new IdentityError("AUTHENTICATION_FAILED", "User authentication is required");
        }
        const session = await this.#clerk.verify(authorization.slice(7), configuration, signal);
        if (session === null) {
            throw new IdentityError("AUTHENTICATION_FAILED", "User authentication failed");
        }
        return { humanId: session.userId, kind: "human", tenantId: session.userId };
    };
}
