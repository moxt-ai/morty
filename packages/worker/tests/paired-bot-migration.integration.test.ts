import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const files = import.meta.glob<string>("../migrations/project-do/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
});
const ordered = Object.keys(files).sort();
const materialization = ordered.findIndex((path) => path.endsWith("/0037_materialize_paired_bots.sql"));

test("Given a user with a configured bot and a bot created by a consumed pairing ticket, When every migration runs, Then the owner keeps one Machine and its conversation", () => {
    using database = new DatabaseSync(":memory:");
    for (const path of ordered.slice(0, materialization)) {
        database.exec(files[path] ?? "");
    }
    database.exec(
        "INSERT INTO managed_bot (user_id, bot_id, display_name, runtime_id, instructions, created_at, updated_at) VALUES ('usr_owner', 'bot_configured', 'Laptop', 'rt_laptop', 'Be brief.', 1, 2)",
    );
    const ticket = database.prepare(
        "INSERT INTO agent_pairing_ticket (code_hash, user_id, bot_id, creates_bot, expires_at, consumed_at) VALUES (?, 'usr_owner', ?, ?, 9, ?)",
    );
    ticket.run("pending", "bot_pending", 1, 5);
    ticket.run("unconsumed", "bot_unconsumed", 1, null);
    ticket.run("configured", "bot_configured", 1, 6);

    for (const path of ordered.slice(materialization)) {
        if (path.endsWith("/0059_soft_grandmaster.sql")) {
            database.exec(
                "INSERT INTO chat_managed_session (project_id, user_id, bot_id, resource_id, harness, session_id, created_at) VALUES ('prj_owner', 'usr_owner', 'bot_configured', 'kept-conversation', 'codex', 'native-kept', 3)",
            );
        }
        database.exec(files[path] ?? "");
    }

    expect(database.prepare("SELECT user_id, created_at FROM managed_bot ORDER BY user_id").all()).toEqual([
        { user_id: "usr_owner", created_at: 1 },
    ]);
    expect(
        database
            .prepare(
                "SELECT computer_id, user_id, resource_id, harness, session_id, created_at FROM chat_managed_session",
            )
            .all(),
    ).toEqual([
        {
            computer_id: "prj_owner",
            user_id: "usr_owner",
            resource_id: "kept-conversation",
            harness: "codex",
            session_id: "native-kept",
            created_at: 3,
        },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_pairing_ticket'").all()).toEqual([]);
});
