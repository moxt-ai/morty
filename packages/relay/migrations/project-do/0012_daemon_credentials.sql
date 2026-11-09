ALTER TABLE runtime_daemon_credentials RENAME TO daemon_credentials;--> statement-breakpoint
ALTER TABLE runtime_daemon_retired_credentials RENAME TO retired_daemon_credentials;--> statement-breakpoint
DROP INDEX runtime_daemon_credentials_token_hash_unique;--> statement-breakpoint
CREATE UNIQUE INDEX daemon_credentials_token_hash_unique ON daemon_credentials(token_hash);--> statement-breakpoint
DROP INDEX runtime_daemon_retired_credentials_runtime;--> statement-breakpoint
CREATE INDEX retired_daemon_credentials_computer ON retired_daemon_credentials(computer_id);
