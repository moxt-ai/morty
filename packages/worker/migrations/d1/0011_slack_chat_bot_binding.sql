CREATE TABLE slack_chat_bot_binding (
    tenant_id TEXT NOT NULL,
    slack_bot_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    project_id TEXT,
    binding_id TEXT,
    runtime_id TEXT,
    agent_ref TEXT,
    workspace_ref TEXT,
    agent_config_revision INTEGER,
    instructions TEXT NOT NULL DEFAULT '',
    legacy_migration_pending INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, slack_bot_id)
);

INSERT INTO slack_chat_bot_binding (tenant_id, slack_bot_id, bot_id, connection_id)
SELECT tenant_id, slack_bot_id, bot_id, connection_id FROM slack_mobius_binding;

DROP TABLE slack_mobius_binding;
