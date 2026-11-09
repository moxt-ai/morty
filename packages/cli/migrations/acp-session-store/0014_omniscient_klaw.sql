CREATE TABLE `session_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acp_session` (
	`agent_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`cwd` text NOT NULL,
	`additional_directories` text NOT NULL,
	`configurations` text DEFAULT '[]' NOT NULL,
	`prompted` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `native_session_id`)
);
--> statement-breakpoint
INSERT INTO `__new_acp_session`("agent_id", "native_session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at") SELECT "agent_id", "native_session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at" FROM `acp_session`;--> statement-breakpoint
DROP TABLE `acp_session`;--> statement-breakpoint
ALTER TABLE `__new_acp_session` RENAME TO `acp_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acp_session` (
	`agent_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`cwd` text NOT NULL,
	`additional_directories` text NOT NULL,
	`configurations` text DEFAULT '[]' NOT NULL,
	`prompted` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_acp_session`("agent_id", "native_session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at") SELECT "agent_id", "native_session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at" FROM `acp_session`;--> statement-breakpoint
DROP TABLE `acp_session`;--> statement-breakpoint
ALTER TABLE `__new_acp_session` RENAME TO `acp_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
ALTER TABLE `acp_session` RENAME COLUMN "native_session_id" TO "session_id";
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acp_session` (
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`cwd` text NOT NULL,
	`additional_directories` text NOT NULL,
	`configurations` text DEFAULT '[]' NOT NULL,
	`prompted` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `session_id`)
);
--> statement-breakpoint
INSERT INTO `__new_acp_session`("agent_id", "session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at") SELECT "agent_id", "session_id", "cwd", "additional_directories", "configurations", "prompted", "title", "updated_at" FROM `acp_session`;--> statement-breakpoint
DROP TABLE `acp_session`;--> statement-breakpoint
ALTER TABLE `__new_acp_session` RENAME TO `acp_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
