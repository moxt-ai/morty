ALTER TABLE `anonymous_credential` ADD `browser_id` text;--> statement-breakpoint
CREATE INDEX `anonymous_credential_browser_idx` ON `anonymous_credential` (`browser_id`);