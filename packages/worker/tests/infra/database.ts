import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as v from "valibot";

class InMemoryD1Statement {
    readonly query: string;
    readonly database: DatabaseSync;
    readonly values: readonly SQLInputValue[];
    constructor(query: string, database: DatabaseSync, values: readonly SQLInputValue[] = []) {
        this.query = query;
        this.database = database;
        this.values = values;
    }
    readonly bind = (...values: readonly unknown[]) =>
        new InMemoryD1Statement(
            this.query,
            this.database,
            values.map((value) => v.parse(v.union([v.string(), v.number(), v.null()]), value)),
        );
    readonly first = async () => this.database.prepare(this.query).get(...this.values) ?? null;
    readonly all = async () => ({ results: this.database.prepare(this.query).all(...this.values), success: true });
    readonly raw = async () =>
        this.database
            .prepare(this.query)
            .all(...this.values)
            .map((row) => Object.values(row));
    readonly run = async () => ({
        meta: { changes: Number(this.database.prepare(this.query).run(...this.values).changes) },
    });
}

export class InMemoryD1Database {
    readonly #database = new DatabaseSync(":memory:");
    constructor() {
        for (const migration of [
            "0001_initial.sql",
            "0002_anonymous_identity.sql",
            "0003_platform_project.sql",
            "0004_platform_origin.sql",
            "0005_agent_pairing.sql",
            "0006_chat_managed_session.sql",
            "0007_identity_transfer_redemptions.sql",
            "0008_remote_access.sql",
            "0009_chat_managed_import.sql",
            "0010_chat_owned_bot.sql",
            "0011_slack_chat_bot_binding.sql",
            "0012_remove_legacy_bot_migration.sql",
        ]) {
            this.#database.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
        }
    }
    readonly close = () => this.#database.close();
    readonly prepare = (query: string) => new InMemoryD1Statement(query, this.#database);
    readonly batch = async (statements: readonly InMemoryD1Statement[]) => {
        this.#database.exec("BEGIN");
        try {
            const results = [];
            for (const statement of statements) {
                results.push(await statement.run());
            }
            this.#database.exec("COMMIT");
            return results;
        } catch (cause) {
            this.#database.exec("ROLLBACK");
            throw cause;
        }
    };
}
