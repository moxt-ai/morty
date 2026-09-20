CREATE TABLE agent_pairing_ticket (
    code_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    claim_nonce TEXT
);
