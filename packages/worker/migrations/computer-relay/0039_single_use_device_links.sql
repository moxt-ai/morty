ALTER TABLE `identity_transfer` ADD `access_expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `identity_transfer` ADD `redeemed_at` integer;