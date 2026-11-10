CREATE TABLE `browser_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`transfer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`replaced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_token_hash_unique` ON `browser_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `browser_credential_device_idx` ON `browser_credential` (`device_id`);--> statement-breakpoint
CREATE INDEX `browser_credential_transfer_idx` ON `browser_credential` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `owner_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "owner_credential_kind" CHECK("owner_credential"."kind" IN ('local', 'recovery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_credential_token_hash_unique` ON `owner_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `owner_credential_user_idx` ON `owner_credential` (`user_id`,`revoked_at`);