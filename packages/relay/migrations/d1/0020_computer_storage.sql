ALTER TABLE machine_accounts RENAME COLUMN account_id TO computer_id;
ALTER TABLE machine_account_grants RENAME COLUMN account_id TO computer_id;
ALTER TABLE service_audit_events RENAME COLUMN account_id TO computer_id;
ALTER TABLE machine_access_revocations RENAME COLUMN account_id TO computer_id;
