PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_command` (
	`command_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`attempt_id` text NOT NULL,
	`admission_order` integer NOT NULL,
	`fate` text NOT NULL,
	`started_at` text,
	CONSTRAINT "command_fate" CHECK("__new_command"."fate" IN ('pending', 'started', 'cancelled', 'interrupted-before-start', 'settled-before-start', 'settled-after-start')),
	CONSTRAINT "command_started_at" CHECK(("__new_command"."fate" IN ('started', 'settled-after-start')) = ("__new_command"."started_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_command`("command_id", "session_id", "command_hash", "attempt_id", "admission_order", "fate", "started_at") SELECT "command_id", "session_id", "command_hash", "attempt_id", "admission_order", "fate", "started_at" FROM `command`;--> statement-breakpoint
DROP TABLE `command`;--> statement-breakpoint
ALTER TABLE `__new_command` RENAME TO `command`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `command_admission_order_idx` ON `command` (`admission_order`);--> statement-breakpoint
CREATE INDEX `command_session_idx` ON `command` (`session_id`,`admission_order`);