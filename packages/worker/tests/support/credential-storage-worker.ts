import { requireIdentityDatabase } from "../../src/components/management/storage/identity-storage-common.ts";
import { ProjectDurableObject as Project } from "../../src/components/project/project-durable-object.ts";
import { DurableObjectDatabase } from "../../src/infra/durable-object-database.ts";
import { managedBot, platformProjectMapping } from "../../src/schema/project-do/index.ts";

export { default } from "../../src/index.ts";

/** Seeds the persisted legacy shape while leaving authentication and revocation on the production HTTP path. */
export class ProjectDurableObject extends Project {
    override async fetch(request: Request): Promise<Response> {
        if (request.url === "https://project.internal/incomplete-bootstrap" && request.method === "DELETE") {
            // Reconstruct an interrupted bootstrap: the credential committed, but the mapping and Machine did not.
            const database = requireIdentityDatabase(new DurableObjectDatabase(this.ctx.storage));
            await database.batch([database.delete(managedBot), database.delete(platformProjectMapping)]);
            return new Response(null, { status: 204 });
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
