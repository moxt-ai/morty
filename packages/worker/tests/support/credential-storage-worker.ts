import * as v from "valibot";
import { requireIdentityDatabase } from "../../src/components/management/storage/identity-storage-common.ts";
import { ProjectDurableObject as Project } from "../../src/components/project/project-durable-object.ts";
import { DurableObjectDatabase } from "../../src/infra/durable-object-database.ts";
import { managedBot, platformProjectMapping } from "../../src/schema/project-do/index.ts";

export { ChatWebSocketDurableObject, default } from "../../src/index.ts";

/** Seeds persisted boundary conditions while keeping authentication and revocation on the production HTTP path. */
export class ProjectDurableObject extends Project {
    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://project.internal/incomplete-bootstrap" && request.method === "DELETE") {
            // Reconstruct an interrupted bootstrap: the credential committed, but the mapping and Machine did not.
            const database = requireIdentityDatabase(new DurableObjectDatabase(this.ctx.storage));
            await database.batch([database.delete(managedBot), database.delete(platformProjectMapping)]);
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://project.internal/additional-machine" && request.method === "POST") {
            // Reconstruct invalid persisted state; current management must reject multiple Machines.
            const machine = v.parse(
                v.object({ userId: v.string(), botId: v.string(), createdAt: v.number() }),
                await request.json(),
            );
            await requireIdentityDatabase(new DurableObjectDatabase(this.ctx.storage))
                .insert(managedBot)
                .values({
                    userId: machine.userId,
                    botId: machine.botId,
                    displayName: "My Machine",
                    createdAt: machine.createdAt,
                    updatedAt: machine.createdAt,
                })
                .run();
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://project.internal/aged-links" && request.method === "POST") {
            // Reconstruct links whose device term has passed: the Durable Object's clock cannot be moved forward.
            this.ctx.storage.sql.exec(
                "UPDATE identity_transfer SET created_at = created_at - (access_expires_at - created_at), expires_at = expires_at - (access_expires_at - created_at), access_expires_at = created_at",
            );
            return new Response(null, { status: 204 });
        }
        if (request.url === "https://project.internal/stored-state") {
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
        if (request.url === "https://project.internal/credential-kinds") {
            if (request.method === "DELETE") {
                this.ctx.storage.sql.exec("UPDATE anonymous_credential SET kind = NULL");
            }
            return Response.json(
                this.ctx.storage.sql
                    .exec<{ kind: string | null }>("SELECT kind FROM anonymous_credential")
                    .toArray()
                    .map((row) => row.kind),
            );
        }
        return await super.fetch(request);
    }
}
