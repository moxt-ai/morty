PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_managed_session` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`is_external` integer NOT NULL,
	`resource_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`project_id`, `user_id`, `bot_id`, `resource_id`)
);
--> statement-breakpoint
INSERT INTO `__new_chat_managed_session`("project_id", "user_id", "bot_id", "is_external", "resource_id", "title", "created_at", "archived_at") SELECT "project_id", "user_id", "bot_id", "is_external", "resource_id", "title", "created_at", "archived_at" FROM `chat_managed_session`;--> statement-breakpoint
DROP TABLE `chat_managed_session`;--> statement-breakpoint
ALTER TABLE `__new_chat_managed_session` RENAME TO `chat_managed_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chat_managed_session_directory` ON `chat_managed_session` (`project_id`,`user_id`,`bot_id`,`created_at`,`resource_id`);