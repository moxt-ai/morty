ALTER TABLE managed_bot ADD COLUMN binding_id TEXT;
ALTER TABLE managed_bot ADD COLUMN runtime_id TEXT;
ALTER TABLE managed_bot ADD COLUMN agent_ref TEXT;
ALTER TABLE managed_bot ADD COLUMN workspace_ref TEXT;
ALTER TABLE managed_bot ADD COLUMN agent_config_revision INTEGER;
ALTER TABLE managed_bot ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE managed_bot ADD COLUMN legacy_migration_pending INTEGER NOT NULL DEFAULT 1;

DROP TABLE chat_access_token;
DROP TABLE chat_session;
