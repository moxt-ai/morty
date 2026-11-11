import * as v from "valibot";
import { requestTestComputerControl } from "../../../relay-test-support/src/backend-fixture.ts";
import { ComputerRelay as ProductionComputerRelay } from "../../src/computer-relay/computer-relay.ts";
import { computerInternalPath } from "../../src/contracts/computer-relay-http.ts";
import { ProjectRowSchema } from "../../src/contracts/relay/relay-records.ts";
import type { ConfiguredRelayBindings } from "../../src/contracts/relay-bindings.ts";
import chat from "../../src/index.ts";

// The public Worker reaches the production ComputerRelay namespace.
export default {
    fetch: async (request: Request, env: ConfiguredRelayBindings) => {
        const url = new URL(request.url);
        const target = url.pathname.match(
            /^\/__test\/computers\/([^/]+)\/harnesses\/([^/]+)\/sessions\/([^/]+)\/close$/u,
        );
        if (target !== null && target[1] !== undefined && target[2] !== undefined && target[3] !== undefined) {
            const result = await requestTestComputerControl(
                env,
                target[1],
                {
                    kind: "session.close",
                    requestId: crypto.randomUUID(),
                    target: { harness: target[2], sessionId: target[3] },
                },
                request.signal,
            );
            return Response.json(result);
        }
        return chat.fetch(request, env);
    },
};

/** Seeds persisted boundary conditions while keeping authentication and revocation on the production HTTP path. */
export class ComputerRelay extends ProductionComputerRelay {
    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://computer.internal/retire-account" && request.method === "POST") {
            const value: unknown = await request.json();
            const input = v.parse(v.object({ computerId: v.string() }), value);
            const stored: unknown = await this.ctx.storage.get("computer-account");
            const account = v.parse(ProjectRowSchema, stored);
            if (account.computer_id !== input.computerId) {
                throw new Error("The test account does not match its Computer.");
            }
            await this.ctx.storage.put("computer-account", { ...account, lifecycle: "deleted" });
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/revoked-computer" && request.method === "POST") {
            const computerId = await request.text();
            const revoked = await super.fetch(
                new Request(new URL(computerInternalPath(computerId, "revocations"), request.url), {
                    method: "POST",
                    signal: request.signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        computerId,
                        now: Date.now(),
                        actorKind: "system",
                        actorId: computerId,
                        auditId: `test-revocation-${crypto.randomUUID()}`,
                    }),
                }),
            );
            if (revoked.status !== 204) {
                return revoked;
            }
            return await super.fetch(
                new Request(`https://computer-relay.internal/computers/${computerId}/computer/revoke`, {
                    method: "DELETE",
                    signal: request.signal,
                }),
            );
        }
        if (request.url === "https://computer.internal/aged-links" && request.method === "POST") {
            // Reconstruct links whose device term has passed: the Durable Object's clock cannot be moved forward.
            this.ctx.storage.sql.exec(
                "UPDATE identity_transfer SET created_at = created_at - (access_expires_at - created_at), expires_at = expires_at - (access_expires_at - created_at), access_expires_at = created_at",
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://computer.internal/stored-state") {
            // Read-only: reports what this object persisted, without opening its database.
            return Response.json({
                keys: [...(await this.ctx.storage.list()).keys()],
                tables: this.ctx.storage.sql
                    .exec<{ name: string }>(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
                    )
                    .toArray()
                    .map((row) => row.name),
            });
        }
        if (request.url === "https://computer.internal/credential-kinds") {
            return Response.json(
                this.ctx.storage.sql
                    .exec<{ kind: string }>(
                        "SELECT kind FROM owner_credential UNION ALL SELECT 'browser' FROM browser_credential",
                    )
                    .toArray()
                    .map((row) => row.kind),
            );
        }
        return await super.fetch(request);
    }
}
