DROP INDEX `browser_device_user_idx`;--> statement-breakpoint
ALTER TABLE `browser_device` DROP COLUMN `user_id`;--> statement-breakpoint
DROP INDEX `owner_credential_user_idx`;--> statement-breakpoint
ALTER TABLE `owner_credential` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `owner_credential` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `browser_credential` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `browser_credential` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `identity_transfer` DROP COLUMN `user_id`;