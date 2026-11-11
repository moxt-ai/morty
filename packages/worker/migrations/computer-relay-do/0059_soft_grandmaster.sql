DROP INDEX `managed_bot_bot_id_unique`;--> statement-breakpoint
ALTER TABLE `managed_bot` DROP COLUMN `bot_id`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_managed_session` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`harness` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`, `resource_id`)
);
--> statement-breakpoint
INSERT INTO `__new_chat_managed_session`("project_id", "user_id", "resource_id", "harness", "session_id", "created_at") SELECT "project_id", "user_id", "resource_id", "harness", "session_id", "created_at" FROM `chat_managed_session`;--> statement-breakpoint
DROP TABLE `chat_managed_session`;--> statement-breakpoint
ALTER TABLE `__new_chat_managed_session` RENAME TO `chat_managed_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_managed_session_native_target` ON `chat_managed_session` (`project_id`,`user_id`,`harness`,`session_id`);--> statement-breakpoint
CREATE INDEX `chat_managed_session_directory` ON `chat_managed_session` (`project_id`,`user_id`,`created_at`,`resource_id`);