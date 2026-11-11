DROP INDEX `identity_transfer_expiry_idx`;--> statement-breakpoint
ALTER TABLE `identity_transfer` DROP COLUMN `expires_at`;