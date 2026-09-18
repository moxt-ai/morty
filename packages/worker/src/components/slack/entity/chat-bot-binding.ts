import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u));
export const chatBotBindingSchema = v.pipe(
    v.object({
        tenantId: identifier,
        slackBotId: identifier,
        botId: identifier,
        connectionId: identifier,
        projectId: identifier,
        bindingId: identifier,
        runtimeId: identifier,
        agentRef: identifier,
        workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
        agentConfigRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
        instructions: v.pipe(v.string(), v.maxLength(100000)),
    }),
    v.readonly(),
);
export type ChatBotBinding = v.InferOutput<typeof chatBotBindingSchema>;
