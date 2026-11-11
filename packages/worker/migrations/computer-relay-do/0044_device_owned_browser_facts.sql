PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_anonymous_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`remote_transfer_id` text,
	`device_id` text,
	CONSTRAINT "anonymous_credential_device_kind" CHECK(("__new_anonymous_credential"."kind" = 'browser') = ("__new_anonymous_credential"."device_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_anonymous_credential`("id", "user_id", "token_hash", "kind", "created_at", "revoked_at", "remote_transfer_id", "device_id") SELECT "id", "user_id", "token_hash", "kind", "created_at", "revoked_at", "remote_transfer_id", "device_id" FROM `anonymous_credential`;--> statement-breakpoint
DROP TABLE `anonymous_credential`;--> statement-breakpoint
ALTER TABLE `__new_anonymous_credential` RENAME TO `anonymous_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `anonymous_credential_token_hash_unique` ON `anonymous_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_user_idx` ON `anonymous_credential` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_remote_transfer_idx` ON `anonymous_credential` (`remote_transfer_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_device_idx` ON `anonymous_credential` (`device_id`);--> statement-breakpoint
CREATE TABLE `__new_identity_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`access_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`created_by_credential_id` text
);
--> statement-breakpoint
INSERT INTO `__new_identity_transfer`("id", "code_hash", "user_id", "expires_at", "access_expires_at", "created_at", "revoked_at", "created_by_credential_id") SELECT "id", "code_hash", "user_id", "expires_at", "access_expires_at", "created_at", "revoked_at", "created_by_credential_id" FROM `identity_transfer`;--> statement-breakpoint
DROP TABLE `identity_transfer`;--> statement-breakpoint
ALTER TABLE `__new_identity_transfer` RENAME TO `identity_transfer`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_code_hash_unique` ON `identity_transfer` (`code_hash`);--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);