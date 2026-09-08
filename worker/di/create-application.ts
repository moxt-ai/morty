import { createInjector } from "typed-inject";
import { AuthenticationController } from "../controller/authentication-controller.ts";
import { CloudController } from "../controller/cloud-controller.ts";
import { WorkspaceController } from "../controller/workspace-controller.ts";
import { BusinessGateway, type CloudBindings } from "../gateway/business-gateway.ts";
import { ClerkGateway } from "../gateway/clerk-gateway.ts";
import { DurableObjectWorkspaceCreator } from "../gateway/workspace-creator.ts";
import { AuthenticationService } from "../service/authentication-service.ts";
import { ConfigurationStorage } from "../storage/configuration-storage.ts";

export function createCloudApplication(bindings: CloudBindings) {
    return createInjector()
        .provideValue("bindings", bindings)
        .provideClass("configurationStorage", ConfigurationStorage)
        .provideClass("clerkGateway", ClerkGateway)
        .provideClass("businessGateway", BusinessGateway)
        .provideClass("authenticationService", AuthenticationService)
        .provideClass("authenticationController", AuthenticationController)
        .provideClass("workspaceCreator", DurableObjectWorkspaceCreator)
        .provideClass("workspaceController", WorkspaceController)
        .provideClass("application", CloudController);
}
