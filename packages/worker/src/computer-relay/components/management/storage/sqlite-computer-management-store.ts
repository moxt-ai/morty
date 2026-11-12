import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { auditEvent } from "../../../schema/pairing-do/index.ts";
import type { ComputerManagementStore } from "./computer-management-store.ts";
import { SqliteComputerRelayStore } from "./sqlite-computer-relay-store.ts";

/**
 * Audit and identity operations over one computer's SQLite storage. Only its ComputerRelay
 * constructs this; callers use the object's operations.
 */
export class SqliteComputerManagementStore extends SqliteComputerRelayStore implements ComputerManagementStore {
    readonly #computerId: string;
    readonly #database: DurableObjectDatabase;

    /** `holdsAccess` answers, from the computer's identities, whether a holder's access to the computer still holds. */
    constructor(
        computerId: string,
        database: DurableObjectDatabase,
        holdsAccess: (holder: SessionAccessHolder, signal: AbortSignal) => Promise<boolean>,
    ) {
        super(computerId, database);
        this.#computerId = computerId;
        this.#database = database;
        this.holdsAccess = holdsAccess;
    }

    readonly holdsAccess: ComputerManagementStore["holdsAccess"];

    readonly recordAudit: ComputerManagementStore["recordAudit"] = async (audit, signal) => {
        await relayDrizzle(this.#database, signal)
            .insert(auditEvent)
            .values({
                auditId: audit.action === "project.created" ? `pae_created_${this.#computerId}` : audit.auditId,
                category: "computer_management",
                computerId: this.#computerId,
                actorKind: audit.actorKind,
                actorId: audit.actorId,
                actorRef: audit.actorRef,
                action: audit.action,
                subjectId: audit.subjectId,
                outcome: audit.outcome,
                detailsJson: audit.detailsJson,
                recordedAt: audit.recordedAt,
            })
            .onConflictDoNothing();
    };
}
