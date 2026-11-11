import { PROJECT_LOCATION_HINTS } from "@morty-build/client/protocol";
import * as v from "valibot";

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const lifecycle = v.picklist(["active", "deleted"]);

export const AuditRowSchema = v.object({
    action: v.string(),
    actor_id: v.string(),
    actor_kind: v.string(),
    actor_ref: v.string(),
    audit_id: v.string(),
    details_json: v.string(),
    outcome: v.picklist(["succeeded", "denied"]),
    computer_id: v.string(),
    recorded_at: nonNegativeInteger,
    subject_id: v.string(),
});
type AuditRow = Readonly<v.InferOutput<typeof AuditRowSchema>>;

/** A Relay audit event kept in its Project's own storage; its Tenant is the Project's. */
export type ProjectAuditRow = AuditRow;

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
    user_id: v.string(),
    lifecycle,
    computer_id: v.string(),
});
export type RelayComputerScopeRow = Readonly<v.InferOutput<typeof RelayComputerScopeRowSchema>>;

export const ProjectRowSchema = v.object({
    user_id: v.string(),
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
