PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtime_connection_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`computer_id` text NOT NULL,
	`connection_epoch` integer NOT NULL,
	`connection_id` text NOT NULL,
	`state` text NOT NULL,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer,
	CONSTRAINT "runtime_connection_state_singleton_check" CHECK("__new_runtime_connection_state"."singleton" = 1),
	CONSTRAINT "runtime_connection_state_state_check" CHECK("__new_runtime_connection_state"."state" in ('online', 'offline', 'revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_runtime_connection_state`("singleton", "computer_id", "connection_epoch", "connection_id", "state", "connected_at", "disconnected_at") SELECT "singleton", "computer_id", "connection_epoch", "connection_id", "state", "connected_at", "disconnected_at" FROM `runtime_connection_state`;--> statement-breakpoint
DROP TABLE `runtime_connection_state`;--> statement-breakpoint
ALTER TABLE `__new_runtime_connection_state` RENAME TO `runtime_connection_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;