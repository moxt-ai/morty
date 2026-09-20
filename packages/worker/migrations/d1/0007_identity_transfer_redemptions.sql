ALTER TABLE identity_transfer
ADD COLUMN redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count BETWEEN 0 AND 5);

UPDATE identity_transfer SET redemption_count = 5 WHERE consumed_at IS NOT NULL;
