CREATE TABLE slack_app (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  slack_bot_id TEXT NOT NULL,
  slack_app_id TEXT NOT NULL UNIQUE,
  slack_client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  signing_secret_encrypted TEXT NOT NULL,
  oauth_redirect_uri TEXT NOT NULL,
  app_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slack_bot_id)
);

CREATE INDEX slack_app_tenant_idx ON slack_app(tenant_id);

CREATE TABLE slack_installation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  slack_app_record_id INTEGER NOT NULL REFERENCES slack_app(id),
  slack_team_id TEXT NOT NULL,
  slack_team_name TEXT,
  slack_bot_user_id TEXT NOT NULL,
  bot_token_encrypted TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'token_revoked', 'uninstalled', 'error')),
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (slack_app_record_id, slack_team_id)
);

CREATE INDEX slack_installation_tenant_idx ON slack_installation(tenant_id);
CREATE INDEX slack_installation_team_idx ON slack_installation(slack_team_id);
CREATE INDEX slack_installation_bot_user_idx ON slack_installation(slack_bot_user_id);

CREATE TABLE slack_conversation_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  slack_app_record_id INTEGER NOT NULL REFERENCES slack_app(id),
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('im', 'channel', 'group', 'mpim')),
  thread_ts TEXT,
  initiator_slack_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  metadata TEXT,
  latest_event_ts TEXT,
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX slack_conversation_mapping_thread_idx
  ON slack_conversation_mapping(tenant_id, slack_app_record_id, connection_id, slack_channel_id, IFNULL(thread_ts, ''));
CREATE INDEX slack_conversation_mapping_conversation_idx ON slack_conversation_mapping(tenant_id, conversation_id);

CREATE TABLE slack_message_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL UNIQUE,
  conversation_mapping_id INTEGER NOT NULL REFERENCES slack_conversation_mapping(id),
  reply_thread_ts TEXT,
  status_thread_ts TEXT,
  trigger_sender_info TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivering', 'completed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX slack_message_delivery_conversation_idx ON slack_message_delivery(conversation_mapping_id);

CREATE TABLE slack_pending_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  conversation_mapping_id INTEGER NOT NULL REFERENCES slack_conversation_mapping(id),
  slack_event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slack_event_id)
);

CREATE INDEX slack_pending_message_conversation_idx
  ON slack_pending_message(tenant_id, conversation_mapping_id, created_at);

CREATE TABLE slack_config_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE slack_user_config_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, human_id)
);

CREATE TABLE processed_slack_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  slack_event_id TEXT NOT NULL,
  slack_app_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE (slack_app_id, slack_event_id)
);

CREATE INDEX processed_slack_event_pending_idx ON processed_slack_event(status, created_at);
CREATE INDEX processed_slack_event_tenant_event_idx ON processed_slack_event(tenant_id, slack_event_id);

CREATE TABLE slack_conversation_lease (
  conversation_key TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE slack_mobius_binding (
    tenant_id TEXT NOT NULL,
    slack_bot_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    delivery_target_id TEXT NOT NULL,
    credential_encrypted TEXT NOT NULL,
    PRIMARY KEY (tenant_id, slack_bot_id),
    FOREIGN KEY (tenant_id, slack_bot_id) REFERENCES slack_app(tenant_id, slack_bot_id)
);
