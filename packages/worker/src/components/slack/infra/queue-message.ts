import * as v from "valibot";
import { slackEventCallbackPayloadSchema } from "../service/events/events";

const slackMessageFileSchema = v.pipe(
    v.object({
        id: v.string(),
        mimetype: v.nullable(v.string()),
        name: v.nullable(v.string()),
        size: v.nullable(v.pipe(v.number(), v.finite())),
        urlPrivate: v.nullable(v.string()),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const userSenderSchema = v.pipe(
    v.object({
        kind: v.literal("user"),
        slackTeamId: v.string(),
        slackUserId: v.string(),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const botSenderSchema = v.pipe(
    v.object({
        botId: v.string(),
        kind: v.literal("bot"),
        slackBotId: v.string(),
        slackTeamId: v.string(),
        targetAccess: v.picklist(["allowed", "denied"]),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export const queueMessageSchema = v.variant("kind", [
    v.pipe(
        v.object({
            kind: v.literal("event"),
            payload: slackEventCallbackPayloadSchema,
        }),
        v.readonly(),
        v.transform((value) => Object.freeze(value)),
    ),
    v.pipe(
        v.object({
            input: v.pipe(
                v.object({
                    botId: v.string(),
                    channelId: v.string(),
                    contextLoadType: v.picklist([
                        "CHANNEL_FULL",
                        "CHANNEL_INCREMENTAL",
                        "THREAD_FULL_WITH_CHANNEL",
                        "THREAD_INCREMENTAL",
                    ]),
                    eventId: v.string(),
                    eventTs: v.string(),
                    files: v.array(slackMessageFileSchema),
                    sender: v.variant("kind", [userSenderSchema, botSenderSchema]),
                    tenantId: v.string(),
                    text: v.string(),
                    threadTs: v.nullable(v.string()),
                }),
                v.readonly(),
                v.transform((value) => Object.freeze(value)),
            ),
            kind: v.literal("pending-conversation"),
        }),
        v.readonly(),
        v.transform((value) => Object.freeze(value)),
    ),
]);

export type SlackQueueMessage = v.InferOutput<typeof queueMessageSchema>;

export const projectQueueMessageSchema = v.object({ projectId: v.string(), message: queueMessageSchema });
export type ProjectQueueMessage = v.InferOutput<typeof projectQueueMessageSchema>;
