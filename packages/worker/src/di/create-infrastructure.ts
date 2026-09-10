import { BusinessGateway } from "../gateway/business-gateway.ts";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import { DurableObjectWorkspaceCreator } from "../gateway/workspace-creator.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import type { CloudInfrastructure } from "./create-dependencies.ts";

export function createCloudInfrastructure(bindings: CloudBindings): CloudInfrastructure {
    const cx = { config: { bindings }, logger: console };
    return {
        ...cx,
        gateways: {
            clerk: new ClerkGateway(cx),
            businesses: new BusinessGateway(cx),
            workspaceCreator: new DurableObjectWorkspaceCreator(cx),
        },
    };
}
