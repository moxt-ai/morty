CREATE TABLE `command` (
	`command_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`attempt_id` text NOT NULL,
	`admission_order` integer NOT NULL,
	`fate` text NOT NULL,
	`started_at` text,
	CONSTRAINT "command_fate" CHECK("command"."fate" IN ('pending', 'started', 'cancelled', 'settled-before-start', 'settled-after-start')),
	CONSTRAINT "command_started_at" CHECK(("command"."fate" IN ('started', 'settled-after-start')) = ("command"."started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `command_admission_order_idx` ON `command` (`admission_order`);--> statement-breakpoint
CREATE INDEX `command_session_idx` ON `command` (`session_id`,`admission_order`);--> statement-breakpoint
CREATE TABLE `command_outcome` (
	`command_id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL
);
