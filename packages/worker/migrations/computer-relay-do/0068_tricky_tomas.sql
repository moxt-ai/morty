PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_browser_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`token_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`transfer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`replaced_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_browser_credential`("id", "user_id", "token_hash", "device_id", "transfer_id", "created_at", "replaced_at") SELECT "id", "user_id", "token_hash", "device_id", "transfer_id", "created_at", "replaced_at" FROM `browser_credential`;--> statement-breakpoint
DROP TABLE `browser_credential`;--> statement-breakpoint
ALTER TABLE `__new_browser_credential` RENAME TO `browser_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_token_hash_unique` ON `browser_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `browser_credential_device_idx` ON `browser_credential` (`device_id`);--> statement-breakpoint
CREATE INDEX `browser_credential_transfer_idx` ON `browser_credential` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `__new_browser_device` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`joined_at` integer NOT NULL,
	`label` text,
	`joined_city` text,
	`joined_country` text,
	`joined_through_transfer_id` text NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_browser_device`("id", "user_id", "joined_at", "label", "joined_city", "joined_country", "joined_through_transfer_id", "ended_at") SELECT "id", "user_id", "joined_at", "label", "joined_city", "joined_country", "joined_through_transfer_id", "ended_at" FROM `browser_device`;--> statement-breakpoint
DROP TABLE `browser_device`;--> statement-breakpoint
ALTER TABLE `__new_browser_device` RENAME TO `browser_device`;--> statement-breakpoint
CREATE INDEX `browser_device_user_idx` ON `browser_device` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_identity_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`access_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_credential_id` text NOT NULL,
	`replaces_transfer_id` text,
	`cancelled_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_identity_transfer`("id", "code_hash", "request_hash", "user_id", "expires_at", "access_expires_at", "created_at", "created_by_credential_id", "replaces_transfer_id", "cancelled_at") SELECT "id", "code_hash", "request_hash", "user_id", "expires_at", "access_expires_at", "created_at", "created_by_credential_id", "replaces_transfer_id", "cancelled_at" FROM `identity_transfer`;--> statement-breakpoint
DROP TABLE `identity_transfer`;--> statement-breakpoint
ALTER TABLE `__new_identity_transfer` RENAME TO `identity_transfer`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_code_hash_unique` ON `identity_transfer` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_replaces_transfer_id_unique` ON `identity_transfer` (`replaces_transfer_id`);--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);--> statement-breakpoint
CREATE TABLE `__new_owner_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "owner_credential_kind" CHECK("__new_owner_credential"."kind" IN ('local', 'recovery'))
);
--> statement-breakpoint
INSERT INTO `__new_owner_credential`("id", "user_id", "token_hash", "kind", "created_at", "revoked_at") SELECT "id", "user_id", "token_hash", "kind", "created_at", "revoked_at" FROM `owner_credential`;--> statement-breakpoint
DROP TABLE `owner_credential`;--> statement-breakpoint
ALTER TABLE `__new_owner_credential` RENAME TO `owner_credential`;--> statement-breakpoint
CREATE UNIQUE INDEX `owner_credential_token_hash_unique` ON `owner_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `owner_credential_user_idx` ON `owner_credential` (`user_id`,`revoked_at`);