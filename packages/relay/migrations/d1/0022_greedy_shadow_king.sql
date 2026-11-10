ALTER TABLE `machine_accounts` RENAME COLUMN "service_id" TO "user_id";--> statement-breakpoint
DROP INDEX `machine_accounts_service`;--> statement-breakpoint
DROP INDEX `machine_accounts_service_id_idempotency_key_unique`;--> statement-breakpoint
DROP INDEX `machine_accounts_service_id_client_reference_unique`;--> statement-breakpoint
CREATE INDEX `machine_accounts_user` ON `machine_accounts` (`user_id`,`lifecycle`,`created_at`,`computer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_accounts_user_id_idempotency_key_unique` ON `machine_accounts` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_accounts_user_id_client_reference_unique` ON `machine_accounts` (`user_id`,`client_reference`);