import * as v from "valibot";
import { relayIdentifier } from "./computer-management.ts";

export const botConfigurationSchema = v.pipe(
    v.object({
        computerId: relayIdentifier,
    }),
    v.readonly(),
);

export type BotConfiguration = v.InferOutput<typeof botConfigurationSchema>;
