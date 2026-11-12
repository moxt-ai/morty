import * as v from "valibot";
import { computerManagementSchema, relayIdentifier } from "./computer-management.ts";

/** A client-held secret binding the created user's identity and its initial computer credential. */
export const anonymousCreationKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));

/** The credential bootstrap issues, derived from its origin so a repeated bootstrap issues the same one. */
const bootstrapOrigin = v.variant("kind", [
    v.pipe(v.object({ kind: v.literal("created"), creationKey: anonymousCreationKey }), v.readonly()),
    // Only the internal replacement path supplies the authenticated predecessor identity.
    v.pipe(
        v.object({
            kind: v.literal("replacement"),
            previousComputerId: relayIdentifier,
            token: v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u)),
        }),
        v.readonly(),
    ),
]);

export type BootstrapOrigin = v.InferOutput<typeof bootstrapOrigin>;

export const computerBootstrap = v.pipe(
    v.object({
        computer: computerManagementSchema,
        origin: bootstrapOrigin,
    }),
    v.readonly(),
);
