import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import type { BusinessGateway } from "../gateway/business-gateway.ts";
import type { AuthenticationController } from "./authentication-controller.ts";
import type { WorkspaceController } from "./workspace-controller.ts";

export class CloudController {
    static readonly inject = ["authenticationController", "businessGateway", "workspaceController"] as const;

    private readonly authentication: AuthenticationController;
    private readonly businesses: BusinessGateway;
    private readonly workspaces: WorkspaceController;

    constructor(
        authentication: AuthenticationController,
        businesses: BusinessGateway,
        workspaces: WorkspaceController,
    ) {
        this.authentication = authentication;
        this.businesses = businesses;
        this.workspaces = workspaces;
    }

    readonly fetch = async (request: Request, context?: ExecutionContext): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (path === "/mobius-cloud/api/workspaces") {
            return await this.workspaces.fetch(request);
        }
        if (path === "/mobius-cloud/api/config" || path === "/mobius-cloud/api/session") {
            return await this.authentication.fetch(request);
        }
        return await this.businesses.fetch(request, context);
    };

    readonly consumeQueue = async (batch: MessageBatch<SlackQueueMessage>): Promise<void> => {
        await this.businesses.consumeQueue(batch);
    };
}
