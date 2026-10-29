import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as v from "valibot";
import { expect, test } from "vitest";
import journal from "../migrations/project-do/meta/_journal.json";

const files = import.meta.glob<string>("../migrations/project-do/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
});
const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./support/schema-migration-worker.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*"],
    loader: { ".sql": "text" },
});
const output = bundle.outputFiles[0];
if (output === undefined) {
    throw new Error("Missing Worker bundle");
}
const opened = v.object({
    columns: v.array(v.record(v.string(), v.unknown())),
    tags: v.array(v.string()),
});

test("Given a Project recorded by migration position without 0023, When it opens, Then it reaches the schema of a new Project and records every migration by tag", async () => {
    // Earlier Workers applied these 33 migrations in this order; 0001_management never ran in a Project.
    const legacy = Object.keys(files)
        .filter((path) => !path.endsWith("/0001_management.sql") && !path.endsWith("/0023_smiling_zaladane.sql"))
        .sort()
        .slice(0, 33);
    expect(legacy).toHaveLength(33);
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-07",
            durableObjects: { PROJECT_SCHEMA: { className: "ProjectSchema", useSQLite: true } },
        }),
    );
    try {
        const seeded = await runtime.dispatchFetch("http://worker.test/position-ledger?project=existing", {
            method: "POST",
            body: JSON.stringify(legacy.map((path) => files[path])),
        });
        expect(seeded.status).toBe(204);
        const open = async (project: string) =>
            v.parse(opened, await (await runtime.dispatchFetch(`http://worker.test/open?project=${project}`)).json());
        const existing = await open("existing");
        const created = await open("created");

        expect(existing.columns).toContainEqual(expect.objectContaining({ table_name: "chat_managed_session" }));
        expect(existing.columns.filter((column) => column["name"] === "archived_at")).toEqual([]);
        expect(existing.columns).toEqual(created.columns);
        for (const project of [existing, created]) {
            expect(project.tags).toEqual(expect.arrayContaining(journal.entries.map((entry) => entry.tag)));
        }
    } finally {
        await runtime.dispose();
    }
});
