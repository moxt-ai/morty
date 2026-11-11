PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_slack_chat_bot_binding` (
	`tenant_id` text NOT NULL,
	`slack_bot_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`project_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`agent_ref` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`tenant_id`, `slack_bot_id`)
);
--> statement-breakpoint
INSERT INTO `__new_slack_chat_bot_binding`("tenant_id", "slack_bot_id", "bot_id", "connection_id", "project_id", "runtime_id", "agent_ref", "instructions") SELECT "tenant_id", "slack_bot_id", "bot_id", "connection_id", "project_id", "runtime_id", "agent_ref", "instructions" FROM `slack_chat_bot_binding`;--> statement-breakpoint
DROP TABLE `slack_chat_bot_binding`;--> statement-breakpoint
ALTER TABLE `__new_slack_chat_bot_binding` RENAME TO `slack_chat_bot_binding`;--> statement-breakpoint
PRAGMA foreign_keys=ON;