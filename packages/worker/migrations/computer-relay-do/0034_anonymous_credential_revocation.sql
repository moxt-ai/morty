PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_anonymous_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`remote_transfer_id` text,
	`browser_id` text
);
--> statement-breakpoint
INSERT INTO `__new_anonymous_credential`("id", "user_id", "token_hash", "created_at", "revoked_at", "remote_transfer_id", "browser_id") SELECT "id", "user_id", "token_hash", "created_at", "revoked_at", "remote_transfer_id", "browser_id" FROM `anonymous_credential`;--> statement-breakpoint
DROP TABLE `anonymous_credential`;--> statement-breakpoint
ALTER TABLE `__new_anonymous_credential` RENAME TO `anonymous_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `anonymous_credential_token_hash_unique` ON `anonymous_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_user_idx` ON `anonymous_credential` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_remote_transfer_idx` ON `anonymous_credential` (`remote_transfer_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `anonymous_credential_browser_idx` ON `anonymous_credential` (`browser_id`);