import * as v from "valibot";
import { platformIdentifier, platformProjectSchema } from "./platform-project.ts";

const replacementIdentity = v.pipe(
    v.object({
        previousProjectId: platformIdentifier,
        token: v.pipe(v.string(), v.regex(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u)),
    }),
    v.readonly(),
);

export type ReplacementIdentity = v.InferOutput<typeof replacementIdentity>;

export const projectBootstrap = v.pipe(
    v.object({
        project: platformProjectSchema,
        userId: platformIdentifier,
        // Only the internal replacement path supplies the authenticated predecessor identity.
        replacement: v.optional(replacementIdentity),
    }),
    v.readonly(),
);
