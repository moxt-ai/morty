ALTER TABLE `chat_managed_session` DROP COLUMN `is_external`;--> statement-breakpoint
ALTER TABLE `slack_chat_bot_binding` DROP COLUMN `project_id`;--> statement-breakpoint
ALTER TABLE `slack_chat_bot_binding` DROP COLUMN `runtime_id`;--> statement-breakpoint
ALTER TABLE `slack_chat_bot_binding` DROP COLUMN `agent_ref`;--> statement-breakpoint
ALTER TABLE `slack_chat_bot_binding` DROP COLUMN `instructions`;