CREATE TABLE app_user (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE anonymous_credential (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES app_user(id),
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE INDEX anonymous_credential_user_idx ON anonymous_credential(user_id, status);

CREATE TABLE clerk_user_binding (
    clerk_user_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES app_user(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE identity_transfer (
    id TEXT PRIMARY KEY NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES app_user(id),
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    claim_nonce TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX identity_transfer_expiry_idx ON identity_transfer(expires_at);

INSERT OR IGNORE INTO app_user (id, created_at)
SELECT user_id, MIN(created_at) FROM managed_bot GROUP BY user_id;

INSERT OR IGNORE INTO app_user (id, created_at)
SELECT user_id, MIN(created_at) FROM chat_session GROUP BY user_id;

INSERT OR IGNORE INTO app_user (id, created_at)
SELECT user_id, MIN(created_at) FROM chat_access_token GROUP BY user_id;

INSERT OR IGNORE INTO clerk_user_binding (clerk_user_id, user_id, created_at, updated_at)
SELECT id, id, created_at, created_at FROM app_user WHERE id LIKE 'user_%';
