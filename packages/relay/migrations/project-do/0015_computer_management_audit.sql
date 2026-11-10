PRAGMA foreign_keys=OFF;
--> statement-breakpoint
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
	CONSTRAINT "audit_event_computer_management" CHECK("__new_audit_events"."category" != 'computer_management' or ("__new_audit_events"."service_id" is not null and "__new_audit_events"."actor_ref" is not null and "__new_audit_events"."subject_id" is not null and "__new_audit_events"."outcome" is not null))
);

--> statement-breakpoint
INSERT INTO `__new_audit_events`("category", "audit_id", "computer_id", "actor_kind", "actor_id", "action", "details_json", "recorded_at", "actor_ref", "service_id", "subject_id", "outcome") SELECT CASE WHEN "category" = 'platform' THEN 'computer_management' ELSE "category" END, "audit_id", "computer_id", "actor_kind", "actor_id", "action", "details_json", "recorded_at", "actor_ref", "service_id", "subject_id", "outcome" FROM `audit_events`;
--> statement-breakpoint
DROP TABLE `audit_events`;
--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `audit_events_category_time` ON `audit_events` (`category`,"recorded_at" desc,"audit_id" desc);
--> statement-breakpoint
CREATE TABLE `__new_computer` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`claimed_at` integer,
	`machine_name` text,
	`workspace_name` text,
	`agents_json` text,
	`connection_epoch` integer DEFAULT 0 NOT NULL,
	`state` text,
	`connected_at` integer,
	`disconnected_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by_owner_credential_id` text,
	CONSTRAINT "computer_registration" CHECK(("__new_computer"."claimed_at" is null and "__new_computer"."machine_name" is null and "__new_computer"."workspace_name" is null and "__new_computer"."agents_json" is null) or ("__new_computer"."claimed_at" is not null and "__new_computer"."machine_name" is not null and "__new_computer"."workspace_name" is not null and "__new_computer"."agents_json" is not null)),
	CONSTRAINT "computer_connection" CHECK(("__new_computer"."connection_epoch" = 0 and "__new_computer"."connected_at" is null and "__new_computer"."state" is null) or ("__new_computer"."connection_epoch" > 0 and "__new_computer"."connected_at" is not null and "__new_computer"."state" is not null and "__new_computer"."state" in ('online', 'offline', 'revoked'))),
	CONSTRAINT "computer_revoked_at_check" CHECK("__new_computer"."revoked_at" is null or (typeof("__new_computer"."revoked_at") = 'integer' and "__new_computer"."revoked_at" >= 0)),
	CONSTRAINT "computer_revocation_actor_check" CHECK("__new_computer"."revoked_by_owner_credential_id" is null or "__new_computer"."revoked_at" is not null)
);

--> statement-breakpoint
INSERT INTO `__new_computer`("computer_id", "claimed_at", "machine_name", "workspace_name", "agents_json", "connection_epoch", "state", "connected_at", "disconnected_at", "created_at", "revoked_at", "revoked_by_owner_credential_id") SELECT "computer_id", "claimed_at", "machine_name", "workspace_name", "agents_json", "connection_epoch", "state", "connected_at", "disconnected_at", "created_at", "revoked_at", "revoked_by_owner_credential_id" FROM `computer`;
--> statement-breakpoint
DROP TABLE `computer`;
--> statement-breakpoint
ALTER TABLE `__new_computer` RENAME TO `computer`;