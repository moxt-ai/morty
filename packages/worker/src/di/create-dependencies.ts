import type { BusinessGateway } from "../gateway/business-gateway.ts";
import type { ClerkGateway } from "../gateway/clerk-gateway.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { AuthenticationService } from "../service/authentication-service.ts";
import type { WorkspaceCreator } from "../service/workspace-creator.ts";
import { ConfigurationStorage } from "../storage/configuration-storage.ts";

export interface CloudInfrastructure {
    readonly config: { readonly bindings: CloudBindings };
    readonly gateways: {
        readonly clerk: ClerkGateway;
        readonly businesses: BusinessGateway;
        readonly workspaceCreator: WorkspaceCreator;
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
