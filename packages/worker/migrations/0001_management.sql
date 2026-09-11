-- Earlier deployments recorded 0001_initial.sql before management tables were
-- added to that file. Create them separately before identity backfill runs.
CREATE TABLE IF NOT EXISTS managed_bot (
    user_id TEXT NOT NULL,
    bot_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS managed_bot_user_idx ON managed_bot(user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_session (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bot_id TEXT NOT NULL REFERENCES managed_bot(bot_id),
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS chat_session_user_updated_idx ON chat_session(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_access_token (
    access_token_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL REFERENCES managed_bot(bot_id),
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_access_token_user_idx ON chat_access_token(user_id, created_at);
