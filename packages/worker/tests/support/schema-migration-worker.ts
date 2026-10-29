import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { DurableObjectDatabase } from "../../src/infra/durable-object-database.ts";

/** A Project Durable Object that can first be brought to a schema an earlier Worker left behind. */
export class ProjectSchema extends DurableObject {
    override async fetch(request: Request) {
        const sql = this.ctx.storage.sql;
        if (new URL(request.url).pathname === "/position-ledger") {
            // Earlier Workers applied these migrations in order and recorded their positions.
            const migrations = v.parse(v.array(v.string()), await request.json());
            sql.exec("CREATE TABLE _chat_schema_migration (version INTEGER PRIMARY KEY NOT NULL)");
            migrations.forEach((migration, index) => {
                sql.exec(migration);
                sql.exec("INSERT INTO _chat_schema_migration (version) VALUES (?)", index + 1);
            });
            return new Response(null, { status: 204 });
        }
        new DurableObjectDatabase(this.ctx.storage);
        return Response.json({
            columns: sql
                .exec(
                    "SELECT m.name AS table_name, c.name, c.type, c.\"notnull\", c.pk FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table' AND m.name NOT LIKE '_cf_%' ORDER BY m.name, c.name",
                )
                .toArray(),
            tags: sql
                .exec("SELECT tag FROM _project_schema_migration ORDER BY tag")
                .toArray()
                .map((row) => row["tag"]),
        });
    }
}

export default {
    fetch: (request: Request, env: { readonly PROJECT_SCHEMA: DurableObjectNamespace<ProjectSchema> }) =>
        env.PROJECT_SCHEMA.get(
            env.PROJECT_SCHEMA.idFromName(new URL(request.url).searchParams.get("project") ?? ""),
        ).fetch(request),
};
