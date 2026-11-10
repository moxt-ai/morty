PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_service_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`computer_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`outcome` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "service_audit_events_computer_id_check" CHECK("__new_service_audit_events"."computer_id" = ''),
	CONSTRAINT "service_audit_events_outcome_check" CHECK("__new_service_audit_events"."outcome" in ('succeeded', 'denied'))
);
--> statement-breakpoint
INSERT INTO `__new_service_audit_events`("audit_id", "service_id", "computer_id", "actor_kind", "actor_id", "actor_ref", "action", "subject_id", "outcome", "details_json", "recorded_at") SELECT "audit_id", "service_id", "computer_id", "actor_kind", "actor_id", "actor_ref", "action", "subject_id", "outcome", "details_json", "recorded_at" FROM `service_audit_events`;--> statement-breakpoint
DROP TABLE `service_audit_events`;--> statement-breakpoint
ALTER TABLE `__new_service_audit_events` RENAME TO `service_audit_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `service_audit_events_service` ON `service_audit_events` (`service_id`,`recorded_at`,`audit_id`);