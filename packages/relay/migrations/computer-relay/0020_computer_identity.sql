ALTER TABLE `runtime_connection` RENAME TO `computer_connection`;--> statement-breakpoint
ALTER TABLE `runtime_pairings` RENAME TO `computer_pairings`;--> statement-breakpoint
ALTER TABLE `runtime_revocations` RENAME TO `computer_pairing_revocations`;--> statement-breakpoint
ALTER TABLE `runtime_registrations` RENAME TO `computer_registrations`;--> statement-breakpoint
DROP INDEX `runtime_pairings_pairing_code_hash_unique`;--> statement-breakpoint
DROP INDEX `runtime_pairings_creation_idempotency_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `computer_pairings_pairing_code_hash_unique` ON `computer_pairings` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_pairings_creation_idempotency_key_unique` ON `computer_pairings` (`creation_idempotency_key`);