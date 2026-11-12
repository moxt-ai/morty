DROP TABLE `chat_managed_session`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_owner_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_owner_credential`("id", "user_id", "token_hash", "created_at", "revoked_at") SELECT "id", "user_id", "token_hash", "created_at", "revoked_at" FROM `owner_credential`;--> statement-breakpoint
DROP TABLE `owner_credential`;--> statement-breakpoint
ALTER TABLE `__new_owner_credential` RENAME TO `owner_credential`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `owner_credential_token_hash_unique` ON `owner_credential` (`token_hash`);--> statement-breakpoint
CREATE INDEX `owner_credential_user_idx` ON `owner_credential` (`user_id`,`revoked_at`);