PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_identity_transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`claim_nonce` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_identity_transfer`("id", "code_hash", "user_id", "expires_at", "claim_nonce", "created_at", "revoked_at") SELECT "id", "code_hash", "user_id", "expires_at", "claim_nonce", "created_at", "revoked_at" FROM `identity_transfer`;--> statement-breakpoint
DROP TABLE `identity_transfer`;--> statement-breakpoint
ALTER TABLE `__new_identity_transfer` RENAME TO `identity_transfer`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_transfer_code_hash_unique` ON `identity_transfer` (`code_hash`);--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);