ALTER TABLE `channel_access_grants` RENAME COLUMN "channel_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `channel_host_credentials` RENAME COLUMN "channel_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `runtime_daemon_credentials` RENAME COLUMN "runtime_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `runtime_daemon_retired_credentials` RENAME COLUMN "runtime_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `runtimes` RENAME COLUMN "runtime_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `runtime_pairing_audit_events` RENAME COLUMN "project_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE `runtime_registrations` RENAME COLUMN "runtime_id" TO "computer_id";--> statement-breakpoint
DROP INDEX `channel_access_grants_channel`;--> statement-breakpoint
CREATE INDEX `channel_access_grants_channel` ON `channel_access_grants` (`computer_id`,`created_at`);--> statement-breakpoint
DROP INDEX `channel_host_credentials_channel`;--> statement-breakpoint
CREATE INDEX `channel_host_credentials_channel` ON `channel_host_credentials` (`computer_id`,`authority`,`revoked_at`,`created_at`);--> statement-breakpoint
DROP INDEX `runtime_daemon_retired_credentials_runtime`;--> statement-breakpoint
CREATE INDEX `runtime_daemon_retired_credentials_runtime` ON `runtime_daemon_retired_credentials` (`computer_id`);--> statement-breakpoint
DROP INDEX `runtimes_channel_id_unique`;--> statement-breakpoint
DROP INDEX `runtimes_project_listing`;--> statement-breakpoint
ALTER TABLE `runtimes` DROP COLUMN `channel_id`;--> statement-breakpoint
ALTER TABLE `runtimes` DROP COLUMN `project_id`;--> statement-breakpoint
DROP INDEX `runtime_pairing_audit_lifecycle`;--> statement-breakpoint
DROP INDEX `runtime_pairing_audit_project`;--> statement-breakpoint
CREATE INDEX `runtime_pairing_audit_project` ON `runtime_pairing_audit_events` (`computer_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
ALTER TABLE `runtime_pairing_audit_events` DROP COLUMN `pairing_id`;--> statement-breakpoint
ALTER TABLE `runtime_pairing_audit_events` DROP COLUMN `runtime_id`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtime_pairing_requests` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`creation_idempotency_key` text,
	`created_by_owner_credential_id` text
);
--> statement-breakpoint
INSERT INTO `__new_runtime_pairing_requests`("computer_id", "pairing_code_hash", "poll_token_hash", "expires_at", "creation_idempotency_key", "created_by_owner_credential_id") SELECT "computer_id", "pairing_code_hash", "poll_token_hash", "expires_at", "creation_idempotency_key", "created_by_owner_credential_id" FROM `runtime_pairing_requests`;--> statement-breakpoint
DROP TABLE `runtime_pairing_requests`;--> statement-breakpoint
ALTER TABLE `__new_runtime_pairing_requests` RENAME TO `runtime_pairing_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_requests_pairing_code_hash_unique` ON `runtime_pairing_requests` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_requests_creation_idempotency_key_unique` ON `runtime_pairing_requests` (`creation_idempotency_key`);--> statement-breakpoint
CREATE INDEX `runtime_pairing_requests_expires_at` ON `runtime_pairing_requests` (`expires_at`);