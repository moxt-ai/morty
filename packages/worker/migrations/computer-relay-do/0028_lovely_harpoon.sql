ALTER TABLE `identity_transfer` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `identity_transfer_expiry_idx` ON `identity_transfer` (`expires_at`);