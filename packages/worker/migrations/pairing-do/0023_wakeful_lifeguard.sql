PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_computer_connection` (
	`connection_epoch` integer PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_computer_connection`("connection_epoch", "generation", "connected_at", "disconnected_at") SELECT "connection_epoch", "generation", "connected_at", "disconnected_at" FROM `computer_connection`;--> statement-breakpoint
DROP TABLE `computer_connection`;--> statement-breakpoint
ALTER TABLE `__new_computer_connection` RENAME TO `computer_connection`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `computer_pairings` DROP COLUMN `computer_id`;