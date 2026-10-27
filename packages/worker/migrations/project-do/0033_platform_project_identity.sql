PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_project_mapping` (
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`project_id` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `app_id`)
);
--> statement-breakpoint
INSERT INTO `__new_platform_project_mapping`("user_id", "app_id", "project_id", "display_name", "created_at") SELECT "user_id", "app_id", "project_id", "display_name", "created_at" FROM `platform_project_mapping`;--> statement-breakpoint
DROP TABLE `platform_project_mapping`;--> statement-breakpoint
ALTER TABLE `__new_platform_project_mapping` RENAME TO `platform_project_mapping`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_project_mapping_project_id_unique` ON `platform_project_mapping` (`project_id`);