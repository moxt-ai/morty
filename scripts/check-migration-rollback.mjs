import { execFileSync } from "node:child_process";

// A release applies its D1 migrations before it activates its Workers, and a failed release restores the Workers
// production ran before, on the database its migrations already changed. A migration may therefore drop or rename
// only what those production Workers no longer use: stop using it in one release, then drop or rename it in a later one.
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
const migrations = "packages/relay/migrations/d1";
const workerSources = ["packages/relay/src", "packages/worker/src"];
const schema = "packages/relay/src/schema/d1";

function productionRevision() {
    const supplied = process.argv[2];
    if (supplied !== undefined) {
        return supplied;
    }
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) {
        throw new Error("The repository is required to read the production release");
    }
    const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 60000 });
    if (JSON.parse(gh("api", `repos/${repository}/releases?per_page=1`)).length === 0) {
        return null;
    }
    return JSON.parse(gh("api", `repos/${repository}/releases/latest`)).target_commitish;
}

const identifier = String.raw`[\`"\[]?([A-Za-z_][A-Za-z0-9_]*)[\`"\]]?`;
const statements = (sql) =>
    sql
        .split(";")
        .map((statement) =>
            statement
                .replace(/--[^\n]*/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter((statement) => statement !== "");

/** What a migration takes away from the schema the production Workers read, named as those Workers know it. */
function removals(sql) {
    const original = new Map();
    const known = (table) => original.get(table) ?? table;
    const recreated = new Set();
    const found = [];
    for (const statement of statements(sql)) {
        let match = statement.match(new RegExp(`^ALTER TABLE ${identifier} RENAME TO ${identifier}$`, "i"));
        if (match !== null) {
            const [, from, to] = match;
            if (from.startsWith("__new_")) {
                recreated.add(to);
            } else {
                found.push({ kind: "table", table: known(from), statement });
                original.set(to, known(from));
            }
            continue;
        }
        match = statement.match(
            new RegExp(`^ALTER TABLE ${identifier} (?:RENAME COLUMN|DROP COLUMN) ${identifier}`, "i"),
        );
        if (match !== null) {
            found.push({ kind: "column", table: known(match[1]), column: match[2], statement });
            continue;
        }
        match = statement.match(new RegExp(`^DROP TABLE (?:IF EXISTS )?${identifier}$`, "i"));
        if (match !== null) {
            found.push({ kind: "table", table: known(match[1]), statement, dropped: match[1] });
        }
    }
    // Rebuilding a table under a temporary name and renaming it back keeps the table.
    return found.filter((removal) => !(removal.dropped !== undefined && recreated.has(removal.dropped)));
}

function definition(source, table) {
    const start = source.search(new RegExp(String.raw`sqliteTable\(\s*["'\`]${table}["'\`]`));
    if (start < 0) {
        return null;
    }
    let depth = 0;
    for (let index = source.indexOf("(", start); index < source.length; index += 1) {
        depth += source[index] === "(" ? 1 : source[index] === ")" ? -1 : 0;
        if (depth === 0) {
            return source.slice(start, index + 1);
        }
    }
    return source.slice(start);
}

const production = productionRevision();
if (production === null) {
    console.log("Nothing has been released yet; no Workers can be restored.");
    process.exit(0);
}
const target = (revision) => JSON.parse(git("show", `${revision}:deployment/targets.json`)).environments.production;
if (target(production).d1_id !== target("HEAD").d1_id) {
    console.log(
        "The release provisions an independent directory; historical migrations do not change the previous database.",
    );
    process.exit(0);
}
const added = git("diff", "--diff-filter=A", "--name-only", production, "HEAD", "--", migrations)
    .split("\n")
    .filter((path) => path.endsWith(".sql"));
const files = (paths) =>
    git("ls-tree", "-r", "--name-only", production, "--", ...paths)
        .split("\n")
        .filter((path) => /\.(ts|tsx|mjs|js)$/.test(path) && !/(^|\/)tests?\//.test(path));
const productionWorkers = files(workerSources).map((path) => git("show", `${production}:${path}`));
const productionSchema = files([schema]).map((path) => git("show", `${production}:${path}`));
const violations = [];
for (const path of added) {
    for (const removal of removals(git("show", `HEAD:${path}`))) {
        const quoted = (name) => new RegExp(String.raw`["'\`]${name}["'\`]`);
        const used =
            removal.kind === "table"
                ? productionWorkers.some((source) => quoted(removal.table).test(source))
                : productionSchema.some((source) =>
                      quoted(removal.column).test(definition(source, removal.table) ?? ""),
                  );
        if (used) {
            violations.push(
                `${path}: ${removal.statement}\n  the production Workers at ${production.slice(0, 12)} still use ${removal.kind === "table" ? `table ${removal.table}` : `${removal.table}.${removal.column}`}`,
            );
        }
    }
}
if (violations.length > 0) {
    console.error(
        `${violations.join("\n")}\n\nA failed release restores these Workers on the migrated database. Release code that no longer uses them first, then drop or rename them in a later release.`,
    );
    process.exit(1);
}
console.log(`${added.length} new D1 migrations keep the production Workers at ${production.slice(0, 12)} working.`);
