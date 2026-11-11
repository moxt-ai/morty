import * as v from "valibot";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import {
    computerAccessRequestSchema,
    computerAuditRequestSchema,
    computerRevocationRequestSchema,
} from "../../../../contracts/computer-relay-http.ts";
import type { ComputerManagementStore } from "../storage/computer-management-store.ts";

function decode<TSchema extends v.GenericSchema>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, input);
    if (!result.success) {
        throw new ComputerManagementError("invalid_request", "The internal computer request is invalid", 400, {
            cause: new v.ValiError(result.issues),
        });
    }
    return result.output;
}

/** Domain operations available only through the owning object's internal HTTP boundary. */
export class ComputerInternalService {
    readonly #computerId: string;
    readonly #store: ComputerManagementStore;

    constructor(computerId: string, store: ComputerManagementStore) {
        this.#computerId = computerId;
        this.#store = store;
    }

    readonly readActiveGeneration = (signal: AbortSignal) => this.#store.readActiveGeneration(this.#computerId, signal);

    readonly holdsAccess = (input: unknown, signal: AbortSignal) =>
        this.#store.holdsAccess(decode(computerAccessRequestSchema, input), signal);

    readonly recordAudit = async (input: unknown, signal: AbortSignal): Promise<void> => {
        const audit = decode(computerAuditRequestSchema, input);
        this.#authorize(audit.computerId);
        await this.#store.recordAudit(audit, signal);
    };

    readonly listComputers = (signal: AbortSignal) => this.#store.listComputers(signal);

    readonly revokeComputer = async (input: unknown, signal: AbortSignal): Promise<void> => {
        const revocation = decode(computerRevocationRequestSchema, input);
        this.#authorize(revocation.computerId);
        await this.#store.revokeComputer(revocation, signal);
    };

    readonly #authorize = (computerId: string): void => {
        if (computerId !== this.#computerId) {
            throw new ComputerManagementError("computer_id_mismatch", "The computer is unavailable", 421);
        }
    };
}
