import type { Context } from "hono";
import { Hono } from "hono";
import * as v from "valibot";
import { tenantContext } from "../../service/identity/tenant-context";
import type { SlackHttpEnvironment } from "../slack-http-environment";

const messageBodySchema = v.pipe(
    v.object({
        channelId: v.pipe(v.string(), v.minLength(1)),
        text: v.pipe(v.string(), v.minLength(1)),
        threadTs: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))), null),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const directMessageBodySchema = v.pipe(
    v.object({ slackUserId: v.pipe(v.string(), v.minLength(1)), text: v.pipe(v.string(), v.minLength(1)) }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const reactionBodySchema = v.pipe(
    v.object({
        channelId: v.pipe(v.string(), v.minLength(1)),
        emojiName: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_+-]{1,100}$/u)),
        messageTs: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const channelMessagesQuerySchema = v.pipe(
    v.object({
        channelId: v.pipe(v.string(), v.minLength(1)),
        limit: v.optional(
            v.pipe(v.unknown(), v.transform(Number), v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)),
            20,
        ),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);
const threadMessagesQuerySchema = v.pipe(
    v.object({
        channelId: v.pipe(v.string(), v.minLength(1)),
        threadTs: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export function createSlackBotToolRoutes() {
    const authenticateTools = async (context: Context<SlackHttpEnvironment>) => {
        const { identities, botTools } = context.env.services;
        const principal = await identities.authenticateBot(
            context.req.header("authorization") ?? null,
            context.req.raw.signal,
        );
        const tenant = tenantContext(principal.tenantId);
        return { principal, tenant, tools: botTools };
    };

    return new Hono<SlackHttpEnvironment>()
        .post("/messages", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const input = v.parse(messageBodySchema, await context.req.json());
            return context.json(await tools.sendMessage(tenant, principal, input, context.req.raw.signal));
        })
        .post("/direct-messages/slack-user", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const input = v.parse(directMessageBodySchema, await context.req.json());
            return context.json(
                await tools.sendDirectMessageToSlackUser(
                    tenant,
                    principal,
                    input.slackUserId,
                    input.text,
                    context.req.raw.signal,
                ),
            );
        })
        .get("/channels", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            return context.json({
                channels: await tools.listChannels(tenant, principal, context.req.raw.signal),
            });
        })
        .get("/channel/messages", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const query = v.parse(channelMessagesQuerySchema, context.req.query());
            return context.json({
                channelId: query.channelId,
                messages: await tools.getChannelMessages(
                    tenant,
                    principal,
                    query.channelId,
                    query.limit,
                    context.req.raw.signal,
                ),
            });
        })
        .get("/thread/messages", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const query = v.parse(threadMessagesQuerySchema, context.req.query());
            return context.json({
                channelId: query.channelId,
                messages: await tools.getThreadMessages(
                    tenant,
                    principal,
                    query.channelId,
                    query.threadTs,
                    context.req.raw.signal,
                ),
                threadTs: query.threadTs,
            });
        })
        .post("/reactions", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const input = v.parse(reactionBodySchema, await context.req.json());
            await tools.addReaction(
                tenant,
                principal,
                input.channelId,
                input.messageTs,
                input.emojiName,
                context.req.raw.signal,
            );
            return context.json({ success: true });
        })
        .delete("/reactions", async (context) => {
            const { principal, tenant, tools } = await authenticateTools(context);
            const input = v.parse(reactionBodySchema, await context.req.json());
            await tools.removeReaction(
                tenant,
                principal,
                input.channelId,
                input.messageTs,
                input.emojiName,
                context.req.raw.signal,
            );
            return context.json({ success: true });
        });
}
