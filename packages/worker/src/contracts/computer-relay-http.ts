import { isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";
import type { RevokeComputer } from "./relay/pairing-records.ts";
import type { RelayAuditRecord } from "./relay/relay-records.ts";

export const COMPUTER_INTERNAL_PREFIX = "/__computer/computers";
export type ComputerInternalResource =
    | "account"
    | "active-generation"
    | "access-check"
    | "audit-events"
    | "registrations"
    | "revocations";
export const computerInternalPath = (computerId: string, resource: ComputerInternalResource): string =>
    `${COMPUTER_INTERNAL_PREFIX}/${encodeURIComponent(computerId)}/${resource}`;

const identifier = v.custom<string>(isIdentifier);
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const computerAccessRequestSchema = v.variant("kind", [
    v.pipe(v.strictObject({ kind: v.literal("credential"), credentialId: identifier }), v.readonly()),
    v.pipe(v.strictObject({ kind: v.literal("device"), deviceId: identifier }), v.readonly()),
]);
export const computerAccessResponseSchema = v.object({ holdsAccess: v.boolean() });
export const computerGenerationResponseSchema = v.object({
    generation: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
export const computerAuditRequestSchema = v.pipe(
    v.strictObject({
        action: v.string(),
        actorId: v.string(),
        actorKind: v.string(),
        actorRef: v.string(),
        auditId: v.string(),
        detailsJson: v.string(),
        outcome: v.picklist(["succeeded", "denied"]),
        computerId: identifier,
        recordedAt: timestamp,
        subjectId: v.string(),
    }),
    v.readonly(),
) satisfies v.GenericSchema<unknown, RelayAuditRecord>;
export const computerRevocationRequestSchema = v.pipe(
    v.strictObject({
        computerId: identifier,
        now: timestamp,
        actorKind: v.string(),
        actorId: v.string(),
        auditId: v.string(),
    }),
    v.readonly(),
) satisfies v.GenericSchema<unknown, RevokeComputer>;
