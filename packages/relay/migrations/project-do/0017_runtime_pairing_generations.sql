CREATE TABLE `daemon_credentials` (
	`generation` integer PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daemon_credentials_token_hash_unique` ON `daemon_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `retired_daemon_credentials` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`successor_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `retired_daemon_credentials_generation` ON `retired_daemon_credentials` (`generation`);--> statement-breakpoint
CREATE TABLE `runtime_connection` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`connection_epoch` integer NOT NULL,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer
);
--> statement-breakpoint
CREATE TABLE `runtime_pairings` (
	`generation` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`computer_id` text NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`creation_idempotency_key` text NOT NULL,
	`created_by_owner_credential_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairings_pairing_code_hash_unique` ON `runtime_pairings` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairings_creation_idempotency_key_unique` ON `runtime_pairings` (`creation_idempotency_key`);--> statement-breakpoint
CREATE TABLE `runtime_registrations` (
	`generation` integer PRIMARY KEY NOT NULL,
	`claimed_at` integer NOT NULL,
	`machine_name` text NOT NULL,
	`workspace_name` text NOT NULL,
	`agents_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runtime_revocations` (
	`generation` integer PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL
);
