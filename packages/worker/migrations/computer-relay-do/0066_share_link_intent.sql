CREATE TABLE `identity_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`access_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_credential_id` text NOT NULL,
	`replaces_transfer_id` text,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_code_hash_unique` ON `identity_transfer` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_replaces_transfer_id_unique` ON `identity_transfer` (`replaces_transfer_id`);--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);