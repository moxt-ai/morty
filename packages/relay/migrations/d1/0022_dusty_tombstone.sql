CREATE TABLE `computer_accounts` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`client_reference` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`lifecycle` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`location_hint` text DEFAULT 'apac' NOT NULL,
	CONSTRAINT "computer_accounts_lifecycle_check" CHECK("computer_accounts"."lifecycle" in ('active', 'deleted')),
	CONSTRAINT "computer_accounts_location_hint_check" CHECK("computer_accounts"."location_hint" in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'))
);
--> statement-breakpoint
CREATE INDEX `computer_accounts_user` ON `computer_accounts` (`user_id`,`lifecycle`,`created_at`,`computer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_accounts_user_id_idempotency_key_unique` ON `computer_accounts` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_accounts_user_id_client_reference_unique` ON `computer_accounts` (`user_id`,`client_reference`);