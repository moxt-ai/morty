import { isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";

export const COMPUTER_INTERNAL_PREFIX = "/__computer/computers";
export type ComputerInternalResource = "account" | "active-generation" | "access-check";
export const computerInternalPath = (computerId: string, resource: ComputerInternalResource): string =>
    `${COMPUTER_INTERNAL_PREFIX}/${encodeURIComponent(computerId)}/${resource}`;

const identifier = v.custom<string>(isIdentifier);
const _timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const computerAccessRequestSchema = v.variant("kind", [
    v.pipe(v.strictObject({ kind: v.literal("credential"), credentialId: identifier }), v.readonly()),
    v.pipe(v.strictObject({ kind: v.literal("device"), deviceId: identifier }), v.readonly()),
]);
export const computerAccessResponseSchema = v.object({ holdsAccess: v.boolean() });
export const computerGenerationResponseSchema = v.object({
    generation: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
