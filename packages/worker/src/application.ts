import { createChatApplication } from "./components/chat/chat-routes.ts";
import { createManagementApplication } from "./components/management/http/create-application.ts";
import type { SlackQueueMessage } from "./components/slack/infra/queue-message.ts";
import { slackApplication } from "./components/slack/slack-application.ts";
import { createApplicationDependencies } from "./composition/application-context.ts";
import { applicationErrorResponse } from "./infra/application-error.ts";
import type { CloudBindings } from "./infra/cloud-bindings.ts";
import { json } from "./infra/http.ts";

const managementApplication = createManagementApplication();
const chatApplication = createChatApplication().onError((error, context) =>
    applicationErrorResponse(error, context.env.logger),
);

export default {
    async fetch(request: Request, bindings: CloudBindings, context?: ExecutionContext): Promise<Response> {
        const path = new URL(request.url).pathname;
        const dependencies = createApplicationDependencies(bindings);
        if (path.startsWith("/mobius-cloud/api/chat/")) {
            return await chatApplication.fetch(request, dependencies, context);
        }
        if (path.startsWith("/mobius-cloud/api/")) {
            return await managementApplication.fetch(request, dependencies, context);
        }
        if (path.startsWith("/mobius-slack/api/")) {
            return await slackApplication.fetch(request, bindings, context);
        }
        return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    },
    async queue(batch, bindings): Promise<void> {
        await slackApplication.queue(batch, bindings);
    },
} satisfies ExportedHandler<CloudBindings, SlackQueueMessage>;
