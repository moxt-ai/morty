ALTER TABLE `runtime_daemon_credentials` RENAME COLUMN "runtime_id" TO "pairing_id";--> statement-breakpoint
ALTER TABLE `runtime_daemon_retired_credentials` RENAME COLUMN "runtime_id" TO "pairing_id";--> statement-breakpoint
ALTER TABLE `runtimes` RENAME COLUMN "runtime_id" TO "pairing_id";--> statement-breakpoint
ALTER TABLE `runtime_registrations` RENAME COLUMN "runtime_id" TO "pairing_id";--> statement-breakpoint
DROP INDEX `runtime_daemon_retired_credentials_runtime`;--> statement-breakpoint
CREATE INDEX `runtime_daemon_retired_credentials_runtime` ON `runtime_daemon_retired_credentials` (`pairing_id`);--> statement-breakpoint
DROP INDEX `runtime_pairing_requests_runtime_id_unique`;--> statement-breakpoint
ALTER TABLE `runtime_pairing_requests` DROP COLUMN `runtime_id`;--> statement-breakpoint
ALTER TABLE `runtime_pairing_audit_events` DROP COLUMN `runtime_id`;