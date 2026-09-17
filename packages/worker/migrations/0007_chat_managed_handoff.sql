ALTER TABLE chat_managed_session RENAME TO chat_managed_session_previous;

CREATE TABLE chat_managed_session (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('conversation', 'fork', 'handoff')),
    resource_id TEXT NOT NULL,
    title TEXT NOT NULL,
    fork_data TEXT,
    created_at INTEGER NOT NULL,
    CHECK ((kind = 'conversation' AND fork_data IS NULL) OR (kind IN ('fork', 'handoff') AND fork_data IS NOT NULL)),
    PRIMARY KEY (project_id, user_id, bot_id, kind, resource_id)
);

INSERT INTO chat_managed_session (project_id, user_id, bot_id, kind, resource_id, title, fork_data, created_at)
SELECT project_id, user_id, bot_id, kind, resource_id, title, fork_data, created_at
FROM chat_managed_session_previous;

DROP TABLE chat_managed_session_previous;

CREATE INDEX chat_managed_session_directory
    ON chat_managed_session (project_id, user_id, bot_id, created_at DESC, resource_id);
