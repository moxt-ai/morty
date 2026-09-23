import * as v from "valibot";
import { platformIdentifier } from "./platform-project.ts";

export const botConfigurationSchema = v.pipe(
    v.object({
        runtimeId: platformIdentifier,
        agentRef: platformIdentifier,
    }),
    v.readonly(),
);

export type BotConfiguration = v.InferOutput<typeof botConfigurationSchema>;
