import * as v from "valibot";
import type { AccountProvisioner } from "../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { accountComputerId } from "../../contracts/computer-id.ts";
import { computerManagementSchema } from "../../contracts/computer-management.ts";
import { computerInternalPath } from "../../contracts/computer-relay-http.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { ProjectRowSchema } from "../../contracts/relay/relay-records.ts";
import { relayBindings } from "../../contracts/relay-bindings.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

/** The Worker provisions accounts through the computer's HTTP boundary, never its services or storage. */
export function accountProvisioner(bindings: CloudBindings): AccountProvisioner {
    return async (reference, locationHint, signal) => {
        const computerId = await accountComputerId(validateIdentifier(reference, "client_reference"), locationHint);
        signal.throwIfAborted();
        const project = { created_at: Date.now(), computer_id: computerId };
        const configured = relayBindings(bindings);
        using deadline = new RequestDeadline(signal, 15_000);
        try {
            deadline.signal.throwIfAborted();
            const stub = configured.COMPUTER_RELAY.getByName(computerId, { locationHint });
            return await deadline.wait(
                (async () => {
                    const response = await stub.fetch(
                        new Request(
                            new URL(computerInternalPath(computerId, "account"), "https://computer-relay.internal"),
                            {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify(project),
                                signal: deadline.signal,
                            },
                        ),
                    );
                    if (response.status !== 200) {
                        await response.body?.cancel();
                        throw new DatabaseError("database_unavailable", "Computer account is unavailable");
                    }
                    const body: unknown = await response.json();
                    const persisted = v.parse(ProjectRowSchema, body);
                    return v.parse(computerManagementSchema, { computerId: persisted.computer_id });
                })(),
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new DatabaseError(
                deadline.signal.aborted ? "database_timeout" : "database_unavailable",
                "Computer storage is unavailable",
                { cause },
            );
        }
    };
}
