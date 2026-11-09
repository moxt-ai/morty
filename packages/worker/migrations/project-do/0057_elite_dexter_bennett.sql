ALTER TABLE `chat_managed_session` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `chat_managed_session` ADD `session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_managed_session_native_target` ON `chat_managed_session` (`project_id`,`user_id`,`bot_id`,`harness`,`session_id`);