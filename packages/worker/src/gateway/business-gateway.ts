import type { SlackQueueMessage } from "@moxt-ai/app-slack-api/infra";
import { fetchMobiusRequest, isMobiusRequest } from "../di/mobius-application.ts";
import { slackApplication } from "../di/slack-application.ts";
import type { CloudBindings } from "../infra/cloud-bindings.ts";
import { json } from "../infra/http.ts";

export type { CloudBindings } from "../infra/cloud-bindings.ts";

export class BusinessGateway {
    readonly #bindings: CloudBindings;
    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.#bindings = cx.config.bindings;
    }
    readonly fetch = async (request: Request, context?: ExecutionContext): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/mobius-slack/api/")) {
            return await slackApplication.fetch(request, this.#bindings, context);
        }
        if (isMobiusRequest(path)) {
            return await fetchMobiusRequest(request, this.#bindings);
        }
        return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    };
    readonly consumeQueue = async (batch: MessageBatch<SlackQueueMessage>): Promise<void> =>
        await slackApplication.queue(batch, this.#bindings);
}
