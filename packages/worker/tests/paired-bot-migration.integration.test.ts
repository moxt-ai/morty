import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const files = import.meta.glob<string>("../migrations/project-do/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
});
const ordered = Object.keys(files).sort();
const materialization = ordered.findIndex((path) => path.endsWith("/0037_materialize_paired_bots.sql"));

test("Given a bot created by a consumed pairing ticket but never configured, When the ticket table is dropped, Then the bot remains an unconfigured managed bot", () => {
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
        database.exec(files[path] ?? "");
    }

    expect(
        database
            .prepare(
                "SELECT user_id, bot_id, display_name, runtime_id, instructions, created_at, updated_at FROM managed_bot ORDER BY bot_id",
            )
            .all(),
    ).toEqual([
        {
            user_id: "usr_owner",
            bot_id: "bot_configured",
            display_name: "Laptop",
            runtime_id: "rt_laptop",
            instructions: "Be brief.",
            created_at: 1,
            updated_at: 2,
        },
        {
            user_id: "usr_owner",
            bot_id: "bot_pending",
            display_name: "My Machine",
            runtime_id: null,
            instructions: "",
            created_at: 5,
            updated_at: 5,
        },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_pairing_ticket'").all()).toEqual([]);
});
