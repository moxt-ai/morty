PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_managed_bot` (
	`user_id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`display_name` text NOT NULL,
	`runtime_id` text,
	`instructions` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_managed_bot`("user_id", "bot_id", "display_name", "runtime_id", "instructions", "created_at", "updated_at") SELECT "user_id", "bot_id", "display_name", "runtime_id", "instructions", "created_at", "updated_at" FROM `managed_bot`;--> statement-breakpoint
DROP TABLE `managed_bot`;--> statement-breakpoint
ALTER TABLE `__new_managed_bot` RENAME TO `managed_bot`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `managed_bot_bot_id_unique` ON `managed_bot` (`bot_id`);