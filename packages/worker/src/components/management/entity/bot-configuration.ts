import * as v from "valibot";
import { platformIdentifier } from "./platform-project.ts";

export const botConfigurationSchema = v.pipe(
    v.object({
        bindingId: platformIdentifier,
        runtimeId: platformIdentifier,
        agentRef: platformIdentifier,
        workspaceRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
        agentConfigRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    v.readonly(),
);

export type BotConfiguration = v.InferOutput<typeof botConfigurationSchema>;
