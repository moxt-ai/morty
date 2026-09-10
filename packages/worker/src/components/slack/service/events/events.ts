import * as v from "valibot";

const slackFileSchema = v.pipe(
    v.object({
        filetype: v.nullish(v.string()),
        id: v.string(),
        mimetype: v.nullish(v.string()),
        name: v.nullish(v.string()),
        size: v.nullish(v.pipe(v.number(), v.finite())),
        url_private: v.nullish(v.string()),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const slackEventSchema = v.pipe(
    v.looseObject({
        bot_id: v.nullish(v.string()),
        channel: v.nullish(v.string()),
        channel_type: v.nullish(v.string()),
        files: v.nullish(v.array(slackFileSchema)),
        subtype: v.nullish(v.string()),
        text: v.nullish(v.string()),
        thread_ts: v.nullish(v.string()),
        ts: v.nullish(v.string()),
        type: v.string(),
        user: v.nullish(v.string()),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

const urlVerificationPayloadSchema = v.pipe(
    v.looseObject({
        api_app_id: v.string(),
        challenge: v.string(),
        type: v.literal("url_verification"),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export const slackEventCallbackPayloadSchema = v.pipe(
    v.looseObject({
        api_app_id: v.string(),
        event: slackEventSchema,
        event_id: v.string(),
        event_time: v.pipe(v.number(), v.finite()),
        team_id: v.string(),
        type: v.literal("event_callback"),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export const slackEventsPayloadSchema = v.variant("type", [
    urlVerificationPayloadSchema,
    slackEventCallbackPayloadSchema,
]);

export type SlackEventCallbackPayload = v.InferOutput<typeof slackEventCallbackPayloadSchema>;
