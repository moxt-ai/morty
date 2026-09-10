import type { ClerkGateway } from "../components/cloud/gateway/clerk-gateway.ts";
import { AuthenticationService } from "../components/cloud/service/authentication-service.ts";
import { ConfigurationStorage } from "../components/cloud/storage/configuration-storage.ts";
import type { BusinessGateway } from "../gateway/business-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";

export interface CloudInfrastructure {
    readonly config: { readonly bindings: CloudBindings };
    readonly gateways: {
        readonly clerk: ClerkGateway;
        readonly businesses: BusinessGateway;
    };
    readonly logger: Pick<Console, "error" | "info" | "warn">;
}

export type CloudContext = ReturnType<typeof createCloudDependencies>;

export function createCloudDependencies(infrastructure: CloudInfrastructure) {
    const storages = Object.freeze({ configuration: new ConfigurationStorage(infrastructure) });
    const cx = { ...infrastructure, storages };
    const services = Object.freeze({ authentication: new AuthenticationService(cx) });
    return Object.freeze({ ...cx, services });
}
