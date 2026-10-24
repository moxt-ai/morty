ALTER TABLE `anonymous_credential` ADD `superseded_by` text;--> statement-breakpoint
CREATE INDEX `anonymous_credential_superseded_by_idx` ON `anonymous_credential` (`superseded_by`);