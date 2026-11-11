import { isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";
import {
    type ComputerControlCommand,
    requestComputerControl,
} from "../../worker/src/computer-relay/components/runtime/service/computer-control-request.ts";
import { computerInternalPath } from "../../worker/src/contracts/computer-relay-http.ts";
import { PairingDirectoryError, parseAgents } from "../../worker/src/contracts/relay/pairing.ts";
import type { RelayBindings } from "../../worker/src/contracts/relay-bindings.ts";
import { RequestDeadline } from "../../worker/src/http/request-deadline.ts";

const identifier = v.custom<string>(isIdentifier);
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const computerRegistrationsResponseSchema = v.object({
    computers: v.array(
        v.object({
            computer_id: identifier,
            claimed_at: timestamp,
            agents_json: v.string(),
            computer_name: v.string(),
            workspace_name: v.string(),
        }),
    ),
});

/** A client of the owning object's production HTTP boundaries, never a second service composition. */
export function createTestComputerBackend(env: RelayBindings, computerId: string) {
    const stub = env.COMPUTER_RELAY.getByName(computerId);
    const request = async (path: string, signal: AbortSignal, method = "GET", body?: unknown) => {
        using deadline = new RequestDeadline(signal, 15_000);
        return await deadline.wait(
            stub.fetch(
                new Request(
                    new URL(
                        path.startsWith("/") ? path : `/computers/${computerId}/${path}`,
                        "https://computer-relay.internal",
                    ),
                    {
                        method,
                        signal: deadline.signal,
                        ...(path === "host" ? { headers: { upgrade: "websocket" } } : {}),
                        ...(body === undefined
                            ? {}
                            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
                    },
                ),
            ),
        );
    };
    const computers = async (signal: AbortSignal) => {
        const registered = await request(computerInternalPath(computerId, "registrations"), signal);
        if (!registered.ok) {
            throw new Error("Computer registrations are unavailable");
        }
        const body: unknown = await registered.json();
        const { computers: rows } = v.parse(computerRegistrationsResponseSchema, body);
        const response = await request("computer-status", signal);
        if (!response.ok) {
            throw new Error("Computer status is unavailable");
        }
        const { online } = v.parse(v.object({ online: v.boolean() }), await response.json());
        return rows.map((row) => ({
            computerId: row.computer_id,
            computerName: row.computer_name,
            workspaceName: row.workspace_name,
            agents: parseAgents(row.agents_json),
            online,
        }));
    };
    return {
        computers,
        agents: async (signal: AbortSignal) => {
            const computer = (await computers(signal))[0];
            if (computer === undefined) {
                throw new Error("Expected a paired Computer");
            }
            return computer;
        },
        revokeComputer: async (signal: AbortSignal) => {
            const revoked = await request(computerInternalPath(computerId, "revocations"), signal, "POST", {
                computerId,
                now: Date.now(),
                actorKind: "application",
                actorId: "test-owner",
                auditId: `test-revocation-${crypto.randomUUID()}`,
            });
            if (revoked.status !== 204) {
                throw new Error("Computer revocation is unavailable");
            }
            const response = await request("computer/revoke", signal, "DELETE");
            if (response.status !== 204) {
                throw new PairingDirectoryError(
                    "computer_disconnect_failed",
                    "The Computer was revoked but its active connection could not be closed",
                );
            }
        },
        openHost: async (signal: AbortSignal) => {
            const response = await request("host", signal);
            if (response.status !== 101 || response.webSocket === null) {
                throw new Error("Host connection failed");
            }
            return response.webSocket;
        },
    };
}

/** Local control scenarios use a real internal Host connection, with no retired HTTP management API. */
export async function requestTestComputerControl(
    env: RelayBindings,
    computerId: string,
    command: ComputerControlCommand,
    signal: AbortSignal,
) {
    const socket = await createTestComputerBackend(env, computerId).openHost(signal);
    return requestComputerControl(socket, command, signal);
}

/**
 * Seeds a revoked Computer: the Relay revokes one when its daemon credential is reused, which a scenario about the
 * revoked state need not stage. The revocation commits in the Computer's storage and closes its daemon connection.
 */
export async function revokeTestComputer(env: RelayBindings, computerId: string, signal: AbortSignal) {
    await createTestComputerBackend(env, computerId).revokeComputer(signal);
}
