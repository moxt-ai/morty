import { PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const lifecycle = v.picklist(["active", "deleted"]);

export interface RelayAuditRecord {
    readonly action: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorRef: string;
    readonly auditId: string;
    readonly detailsJson: string;
    readonly outcome: "succeeded" | "denied";
    readonly computerId: string;
    readonly recordedAt: number;
    readonly subjectId: string;
}

export const RelayComputerScopeRowSchema = v.object({
    lifecycle,
    computer_id: v.string(),
});
export type RelayComputerScopeRow = Readonly<v.InferOutput<typeof RelayComputerScopeRowSchema>>;

export const ProjectRowSchema = v.object({
    client_reference: v.string(),
    created_at: nonNegativeInteger,
    deleted_at: v.nullable(nonNegativeInteger),
    display_name: v.string(),
    idempotency_key: v.string(),
    lifecycle,
    location_hint: v.picklist(PROJECT_LOCATION_HINTS),
    computer_id: v.string(),
    updated_at: nonNegativeInteger,
});
export type ProjectRow = Readonly<v.InferOutput<typeof ProjectRowSchema>>;
