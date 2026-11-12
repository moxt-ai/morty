import type { ProjectLocationHint, SessionAccessHolder } from "@morty-build/client/protocol";
import * as v from "valibot";
import { decodeComputerPlacement } from "../../contracts/computer-id.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import {
    type ComputerInternalResource,
    computerAccessResponseSchema,
    computerGenerationResponseSchema,
    computerInternalPath,
} from "../../contracts/computer-relay-http.ts";
import { type ProjectRow, ProjectRowSchema, RelayComputerScopeRowSchema } from "../../contracts/relay/relay-records.ts";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

/** Cross-computer operations only; computer-local services never loop back through their own endpoint. */
export class ComputerRelayGateway {
    readonly #bindings: ConfiguredRelayBindings;
    readonly #computerId: string;
    readonly #locationHint: ProjectLocationHint;

    constructor(bindings: ConfiguredRelayBindings, computerId: string) {
        this.#bindings = bindings;
        this.#computerId = v.parse(relayIdentifier, computerId);
        const placement = decodeComputerPlacement(this.#computerId);
        if (placement === null) {
            throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Project ID is invalid.", 400);
        }
        this.#locationHint = placement.locationHint;
    }

    readonly #call = async <Value>(
        signal: AbortSignal,
        operation: (stub: DurableObjectStub, signal: AbortSignal) => Promise<Value>,
        milliseconds = 15_000,
    ): Promise<Value> => {
        using deadline = new RequestDeadline(signal, milliseconds);
        try {
            const stub = this.#bindings.COMPUTER_RELAY.getByName(this.#computerId, {
                locationHint: this.#locationHint,
            });
            return await deadline.wait(operation(stub, deadline.signal));
        } catch (cause) {
            signal.throwIfAborted();
            throw new DatabaseError(
                deadline.signal.aborted ? "database_timeout" : "database_unavailable",
                "Computer storage is unavailable",
                { cause },
            );
        }
    };

    readonly #request = (resource: ComputerInternalResource, signal: AbortSignal, body?: unknown): Request =>
        new Request(new URL(computerInternalPath(this.#computerId, resource), "https://computer-relay.internal"), {
            method: body === undefined ? "GET" : "POST",
            signal,
            ...(body === undefined
                ? {}
                : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });

    readonly holdsAccess = (holder: SessionAccessHolder, signal: AbortSignal): Promise<boolean> =>
        this.#call(signal, async (stub, signal) => {
            const response = await stub.fetch(this.#request("access-check", signal, holder));
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new DatabaseError("database_unavailable", "Computer access is unavailable");
            }
            const body: unknown = await response.json();
            return v.parse(computerAccessResponseSchema, body).holdsAccess;
        });

    readonly readActiveComputerScope = (computerId: string, signal: AbortSignal) => {
        if (computerId !== this.#computerId) {
            throw new DatabaseError("database_unavailable", "Computer storage is unavailable");
        }
        return this.#call(signal, async (stub, signal) => {
            const response = await stub.fetch(this.#request("account", signal));
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new DatabaseError("database_unavailable", "Computer account is unavailable");
            }
            const body: unknown = await response.json();
            return v.parse(v.nullable(RelayComputerScopeRowSchema), body);
        });
    };

    readonly createComputerAccount = (project: ProjectRow, signal: AbortSignal) => {
        if (project.computer_id !== this.#computerId) {
            throw new DatabaseError("database_unavailable", "Computer storage is unavailable");
        }
        return this.#call(signal, async (stub, signal) => {
            const response = await stub.fetch(this.#request("account", signal, project));
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new DatabaseError("database_unavailable", "Computer account is unavailable");
            }
            const body: unknown = await response.json();
            return v.parse(ProjectRowSchema, body);
        });
    };
    readonly readActiveGeneration = (computerId: string, signal: AbortSignal): Promise<number | null> => {
        if (computerId !== this.#computerId) {
            throw new DatabaseError("database_unavailable", "Computer storage is unavailable");
        }
        return this.#call(signal, async (stub, signal) => {
            const response = await stub.fetch(this.#request("active-generation", signal));
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new DatabaseError("database_unavailable", "Computer generation is unavailable");
            }
            const body: unknown = await response.json();
            return v.parse(computerGenerationResponseSchema, body).generation;
        });
    };
    readonly bootstrap = (request: Request): Promise<Response> =>
        this.#call(request.signal, (stub, signal) => stub.fetch(new Request(request, { signal })), 45_000);
}
