import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
export const mobiusBindingSchema = v.pipe(
    v.object({
        tenantId: identifier,
        slackBotId: identifier,
        botId: identifier,
        connectionId: identifier,
        deliveryTargetId: identifier,
        credential: v.pipe(v.string(), v.minLength(32)),
    }),
    v.readonly(),
);
export type MobiusBinding = v.InferOutput<typeof mobiusBindingSchema>;
