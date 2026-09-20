ALTER TABLE identity_transfer ADD COLUMN revoked_at INTEGER;

ALTER TABLE anonymous_credential ADD COLUMN remote_transfer_id TEXT;

CREATE INDEX anonymous_credential_remote_transfer_idx
ON anonymous_credential(remote_transfer_id, status);
