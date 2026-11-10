PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`category` text NOT NULL,
	`audit_id` text NOT NULL,
	`computer_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`actor_ref` text,
	`service_id` text,
	`subject_id` text,
	`outcome` text,
	PRIMARY KEY(`category`, `audit_id`),
	CONSTRAINT "audit_event_category" CHECK("__new_audit_events"."category" in ('authentication','pairing','computer_management')),
	CONSTRAINT "audit_event_computer_management" CHECK("__new_audit_events"."category" != 'computer_management' or ("__new_audit_events"."actor_ref" is not null and "__new_audit_events"."subject_id" is not null and "__new_audit_events"."outcome" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("category", "audit_id", "computer_id", "actor_kind", "actor_id", "action", "details_json", "recorded_at", "actor_ref", "service_id", "subject_id", "outcome") SELECT "category", "audit_id", "computer_id", "actor_kind", "actor_id", "action", "details_json", "recorded_at", "actor_ref", "service_id", "subject_id", "outcome" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_events_category_time` ON `audit_events` (`category`,`recorded_at`,`audit_id`);