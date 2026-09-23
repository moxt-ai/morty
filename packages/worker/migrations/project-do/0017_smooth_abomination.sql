ALTER TABLE `processed_slack_event` RENAME TO `slack_processed_event`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_slack_processed_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`slack_event_id` text NOT NULL,
	`slack_app_id` text NOT NULL,
	`slack_team_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	CONSTRAINT "slack_processed_event_status_check" CHECK("__new_slack_processed_event"."status" in ('pending', 'processing', 'processed', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_slack_processed_event`("id", "tenant_id", "slack_event_id", "slack_app_id", "slack_team_id", "payload", "status", "created_at", "processed_at") SELECT "id", "tenant_id", "slack_event_id", "slack_app_id", "slack_team_id", "payload", "status", "created_at", "processed_at" FROM `slack_processed_event`;--> statement-breakpoint
DROP TABLE `slack_processed_event`;--> statement-breakpoint
ALTER TABLE `__new_slack_processed_event` RENAME TO `slack_processed_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `slack_processed_event_pending_idx` ON `slack_processed_event` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_processed_event_tenant_event_idx` ON `slack_processed_event` (`tenant_id`,`slack_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_processed_event_slack_app_id_slack_event_id_unique` ON `slack_processed_event` (`slack_app_id`,`slack_event_id`);--> statement-breakpoint
DROP INDEX `chat_managed_session_directory`;--> statement-breakpoint
ALTER TABLE `chat_managed_session` ADD `is_external` integer GENERATED ALWAYS AS (kind = 'import') VIRTUAL;--> statement-breakpoint
CREATE INDEX `chat_managed_session_directory` ON `chat_managed_session` (`project_id`,`user_id`,`bot_id`,`created_at`,`resource_id`);