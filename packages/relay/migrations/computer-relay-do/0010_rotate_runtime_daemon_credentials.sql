CREATE TABLE `runtime_daemon_retired_credentials` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`successor_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runtime_daemon_retired_credentials_runtime` ON `runtime_daemon_retired_credentials` (`runtime_id`);