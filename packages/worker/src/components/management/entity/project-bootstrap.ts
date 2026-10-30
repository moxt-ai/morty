import * as v from "valibot";
import { platformIdentifier, platformProjectSchema } from "./platform-project.ts";

/** A client-held secret that names one anonymous user creation, so retrying it resumes the same identity. */
export const anonymousCreationKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));

/** The credential bootstrap issues, derived from its origin so a repeated bootstrap issues the same one. */
const bootstrapOrigin = v.variant("kind", [
    v.pipe(v.object({ kind: v.literal("created"), creationKey: anonymousCreationKey }), v.readonly()),
    // Only the internal replacement path supplies the authenticated predecessor identity.
    v.pipe(
        v.object({
            kind: v.literal("replacement"),
            previousProjectId: platformIdentifier,
            token: v.pipe(v.string(), v.regex(/^mobius_anon_v2_[A-Za-z0-9_-]{43}$/u)),
        }),
        v.readonly(),
    ),
]);

export type BootstrapOrigin = v.InferOutput<typeof bootstrapOrigin>;

export const projectBootstrap = v.pipe(
    v.object({
        project: platformProjectSchema,
        userId: platformIdentifier,
        origin: bootstrapOrigin,
    }),
    v.readonly(),
);
