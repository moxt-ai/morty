import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import keepOneMachine from "../migrations/project-do/0052_keep_one_machine_per_identity.sql?raw";
import machineKeyedByOwner from "../migrations/project-do/0053_machine_keyed_by_owner.sql?raw";

test("Given a Project object holding several Machines from older state, When its schema is migrated, Then only the Machine bound to a Runtime remains with its conversations", () => {
    using database = new DatabaseSync(":memory:");
    // The tables as they stood before a Project identity was keyed to one Machine.
    database.exec(`
        CREATE TABLE managed_bot (
            user_id text NOT NULL, bot_id text PRIMARY KEY NOT NULL, display_name text NOT NULL, runtime_id text,
            instructions text DEFAULT '' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL
        );
        CREATE TABLE chat_managed_session (
            project_id text NOT NULL, user_id text NOT NULL, bot_id text NOT NULL, resource_id text NOT NULL,
            created_at integer NOT NULL, PRIMARY KEY (project_id, user_id, bot_id, resource_id)
        );
        INSERT INTO managed_bot VALUES ('usr_owner', 'bot_first', 'My Machine', NULL, '', 1, 1);
        INSERT INTO managed_bot VALUES ('usr_owner', 'bot_bound', 'My Machine', 'rt_bound', '', 2, 2);
        INSERT INTO chat_managed_session VALUES ('prj_owner', 'usr_owner', 'bot_first', 'ses_first', 1);
        INSERT INTO chat_managed_session VALUES ('prj_owner', 'usr_owner', 'bot_bound', 'ses_bound', 2);
    `);

    for (const migration of [keepOneMachine, machineKeyedByOwner]) {
        database.exec("BEGIN");
        for (const statement of migration.split("--> statement-breakpoint")) {
            database.exec(statement);
        }
        database.exec("COMMIT");
    }

    expect(database.prepare("SELECT user_id, bot_id, runtime_id FROM managed_bot").all()).toEqual([
        { user_id: "usr_owner", bot_id: "bot_bound", runtime_id: "rt_bound" },
    ]);
    expect(database.prepare("SELECT bot_id, resource_id FROM chat_managed_session").all()).toEqual([
        { bot_id: "bot_bound", resource_id: "ses_bound" },
    ]);
    // The owner is the key: a second Machine can no longer be stored.
    expect(() =>
        database.exec("INSERT INTO managed_bot VALUES ('usr_owner', 'bot_second', 'My Machine', NULL, '', 3, 3)"),
    ).toThrow(/UNIQUE constraint failed: managed_bot.user_id/u);
});
