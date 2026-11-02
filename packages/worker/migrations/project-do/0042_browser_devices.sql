CREATE TABLE `browser_device` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	`label` text,
	`joined_through_transfer_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_device_user_idx` ON `browser_device` (`user_id`);--> statement-breakpoint
ALTER TABLE `anonymous_credential` ADD `device_id` text;--> statement-breakpoint
CREATE INDEX `anonymous_credential_device_idx` ON `anonymous_credential` (`device_id`);