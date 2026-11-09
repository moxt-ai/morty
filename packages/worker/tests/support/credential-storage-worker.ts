import { requireIdentityDatabase } from "../../src/components/management/storage/identity-storage-common.ts";
import { ComputerDurableObject as Project } from "../../src/components/project/computer-durable-object.ts";
import { DurableObjectDatabase } from "../../src/infra/durable-object-database.ts";
import { managedBot } from "../../src/schema/project-do/index.ts";

export { ChatWebSocketDurableObject, default } from "../../src/index.ts";

/** Seeds persisted boundary conditions while keeping authentication and revocation on the production HTTP path. */
export class ComputerDurableObject extends Project {
    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://computer.internal/incomplete-bootstrap" && request.method === "DELETE") {
            // Reconstruct an interrupted bootstrap: the credential committed, but the mapping and Machine did not.
            const database = requireIdentityDatabase(new DurableObjectDatabase(this.ctx.storage));
            await database.delete(managedBot).run();
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
                    .exec<{ kind: string }>("SELECT kind FROM anonymous_credential")
                    .toArray()
                    .map((row) => row.kind),
            );
        }
        return await super.fetch(request);
    }
}
