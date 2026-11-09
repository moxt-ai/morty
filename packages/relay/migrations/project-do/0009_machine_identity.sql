ALTER TABLE `project_browser_credentials` RENAME TO `machine_browser_credentials`;--> statement-breakpoint
ALTER TABLE `project_object_identity` RENAME TO `machine_account_identity`;--> statement-breakpoint
DROP TABLE `platform_app_credential_projects`;--> statement-breakpoint
DROP INDEX `project_browser_credentials_token_hash_unique`;--> statement-breakpoint
DROP INDEX `project_browser_credentials_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_browser_credentials_token_hash_unique` ON `machine_browser_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `machine_browser_credentials_project` ON `machine_browser_credentials` (`project_id`,`revoked_at`,`expires_at`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine_account_identity` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	CONSTRAINT "machine_account_identity_singleton_check" CHECK("__new_machine_account_identity"."singleton" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_machine_account_identity`("singleton", "project_id") SELECT "singleton", "project_id" FROM `machine_account_identity`;--> statement-breakpoint
DROP TABLE `machine_account_identity`;--> statement-breakpoint
ALTER TABLE `__new_machine_account_identity` RENAME TO `machine_account_identity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_account_identity_project_id_unique` ON `machine_account_identity` (`project_id`);