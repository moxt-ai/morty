CREATE TABLE chat_managed_session (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('conversation', 'fork')),
    resource_id TEXT NOT NULL,
    title TEXT NOT NULL,
    fork_data TEXT,
    created_at INTEGER NOT NULL,
    CHECK ((kind = 'conversation' AND fork_data IS NULL) OR (kind = 'fork' AND fork_data IS NOT NULL)),
    PRIMARY KEY (project_id, user_id, bot_id, kind, resource_id)
);

CREATE INDEX chat_managed_session_directory
    ON chat_managed_session (project_id, user_id, bot_id, created_at DESC, resource_id);
