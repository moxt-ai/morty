PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_anonymous_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`replaced_at` integer,
	`remote_transfer_id` text,
	`device_id` text,
	CONSTRAINT "anonymous_credential_kind" CHECK("__new_anonymous_credential"."kind" IN ('local', 'browser', 'recovery')),
	CONSTRAINT "anonymous_credential_device_kind" CHECK(("__new_anonymous_credential"."kind" = 'browser') = ("__new_anonymous_credential"."device_id" IS NOT NULL)),
	CONSTRAINT "anonymous_credential_transfer_kind" CHECK(("__new_anonymous_credential"."kind" = 'browser') = ("__new_anonymous_credential"."remote_transfer_id" IS NOT NULL)),
	CONSTRAINT "anonymous_credential_revoked_kind" CHECK("__new_anonymous_credential"."kind" <> 'browser' OR "__new_anonymous_credential"."revoked_at" IS NULL),
	CONSTRAINT "anonymous_credential_replaced_kind" CHECK("__new_anonymous_credential"."kind" = 'browser' OR "__new_anonymous_credential"."replaced_at" IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_anonymous_credential`("id", "user_id", "token_hash", "kind", "created_at", "revoked_at", "replaced_at", "remote_transfer_id", "device_id") SELECT "id", "user_id", "token_hash", "kind", "created_at", "revoked_at", "replaced_at", "remote_transfer_id", "device_id" FROM `anonymous_credential`;--> statement-breakpoint
DROP TABLE `anonymous_credential`;--> statement-breakpoint
ALTER TABLE `__new_anonymous_credential` RENAME TO `anonymous_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `anonymous_credential_token_hash_unique` ON `anonymous_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_user_idx` ON `anonymous_credential` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_remote_transfer_idx` ON `anonymous_credential` (`remote_transfer_id`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_device_idx` ON `anonymous_credential` (`device_id`);