import { Hono } from "hono";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { slackProjectContext } from "../../../middleware/project-context.ts";
import { slackWorker } from "../composition/cloudflare-slack-worker.ts";

export { createSlackApplication } from "./slack-api-routes.ts";

export const slackRoutes = new Hono<{ readonly Bindings: CloudBindings }>()
    .use("*", slackProjectContext)
    .all("*", (context) => slackWorker.fetch(context.req.raw, context.var.projectBindings));
