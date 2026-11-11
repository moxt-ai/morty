import * as v from "valibot";
import { ProjectRowSchema } from "../../src/contracts/relay/relay-records.ts";
import { SqliteComputerRelayStore } from "../../src/computer-relay/components/management/storage/sqlite-computer-relay-store.ts";
import { ComputerRelay as ProductionComputerRelay } from "../../src/computer-relay/computer-relay.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import chat from "../../src/index.ts";

// The public Worker reaches the production ComputerRelay namespace.
export default chat;

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
            await new SqliteComputerRelayStore(computerId, new DurableObjectDatabase(this.ctx.storage)).revokeComputer(
                {
                    computerId,
                    now: Date.now(),
                    actorKind: "system",
                    actorId: computerId,
                    auditId: `test-revocation-${crypto.randomUUID()}`,
                },
                request.signal,
            );
            return new Response(null, { status: 204 });
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
