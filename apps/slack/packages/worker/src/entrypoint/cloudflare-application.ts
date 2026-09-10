import {
    createSlackApplication,
    createSlackDependencies,
    createSlackFileHandler,
    createSlackWorker,
    slackApiPrefix,
} from "@moxt-ai/app-slack-api";
import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import { SlackQueueController } from "../controller/slack-queue-controller";
import type { WorkerBindings } from "../di/create-cloudflare-environment";
import { createCloudflareInfrastructure } from "../di/create-cloudflare-infrastructure";

const application = createSlackApplication();

export function createCloudflareWorker(): ExportedHandler<WorkerBindings, SlackQueueMessage> {
    const slack = createSlackWorker<WorkerBindings, ExecutionContext, MessageBatch<SlackQueueMessage>>(
        (environment) => {
            const cx = createSlackDependencies(createCloudflareInfrastructure(environment));
            return {
                fetchApi: async (request, _apiEnvironment, context) => await application.fetch(request, cx, context),
                fetchFile: createSlackFileHandler(cx.services.slackFiles, cx.gateways.tenantShardingDirectory),
                consumeQueue: new SlackQueueController(cx.services.queueConsumer, cx.logger).consume,
            };
        },
    );
    return {
        fetch: async (request, environment, context) => {
            const pathname = new URL(request.url).pathname;
            if (!pathname.startsWith(`${slackApiPrefix}/`)) {
                return await environment.ASSETS.fetch(request);
            }
            return await slack.fetch(request, environment, context);
        },
        queue: slack.queue,
    };
}
