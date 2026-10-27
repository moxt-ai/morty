import { ProjectDurableObject as Project } from "../../src/components/project/project-durable-object.ts";

export { default } from "../../src/index.ts";

/** Seeds the persisted legacy shape while leaving authentication and revocation on the production HTTP path. */
export class ProjectDurableObject extends Project {
    override async fetch(request: Request): Promise<Response> {
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
