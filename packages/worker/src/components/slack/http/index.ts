import { Hono } from "hono";
import type { CloudBindings } from "../../../infra/cloud-bindings.ts";
import { slackProjectContext } from "../../../middleware/project-context.ts";
import { slackWorker } from "../composition/cloudflare-slack-worker.ts";

export { createSlackApplication } from "./slack-api-routes.ts";

type SlackRouteEnvironment = {
    readonly Bindings: CloudBindings;
    readonly Variables: { readonly projectBindings: CloudBindings };
};

export const slackRoutes = new Hono<SlackRouteEnvironment>()
    .use("*", slackProjectContext)
    .all("*", (context) => slackWorker.fetch(context.req.raw, context.var.projectBindings));

const publicSlackApi = new Hono<{ readonly Bindings: CloudBindings }>()
    .get("/health", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .post("/slack/events", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .get("/slack/oauth/callback", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .get("/files/*", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .get("/bot/slack/channels", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .get("/bot/slack/channel/messages", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .get("/bot/slack/thread/messages", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .post("/bot/slack/messages", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .post("/bot/slack/direct-messages/slack-user", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .post("/bot/slack/reactions", (context) => slackRoutes.fetch(context.req.raw, context.env))
    .delete("/bot/slack/reactions", (context) => slackRoutes.fetch(context.req.raw, context.env));

export const publicSlackRoutes = new Hono<{ readonly Bindings: CloudBindings }>().route("/", publicSlackApi);
