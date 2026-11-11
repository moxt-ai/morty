CREATE TABLE `audit_events` (
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
	CONSTRAINT "audit_event_category" CHECK("audit_events"."category" in ('authentication','pairing','platform')),
	CONSTRAINT "audit_event_platform" CHECK("audit_events"."category" != 'platform' or ("audit_events"."service_id" is not null and "audit_events"."actor_ref" is not null and "audit_events"."subject_id" is not null and "audit_events"."outcome" is not null))
);
--> statement-breakpoint
CREATE INDEX `audit_events_category_time` ON `audit_events` (`category`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
CREATE TABLE `computer` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`claimed_at` integer,
	`machine_name` text,
	`workspace_name` text,
	`agents_json` text,
	`connection_epoch` integer DEFAULT 0 NOT NULL,
	`connection_id` text,
	`state` text,
	`connected_at` integer,
	`disconnected_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by_owner_credential_id` text,
	CONSTRAINT "computer_registration" CHECK(("computer"."claimed_at" is null and "computer"."machine_name" is null and "computer"."workspace_name" is null and "computer"."agents_json" is null) or ("computer"."claimed_at" is not null and "computer"."machine_name" is not null and "computer"."workspace_name" is not null and "computer"."agents_json" is not null)),
	CONSTRAINT "computer_connection" CHECK(("computer"."connection_epoch" = 0 and "computer"."connection_id" is null and "computer"."connected_at" is null and "computer"."state" is null) or ("computer"."connection_epoch" > 0 and "computer"."connection_id" is not null and "computer"."connected_at" is not null and "computer"."state" is not null and "computer"."state" in ('online', 'offline', 'revoked'))),
	CONSTRAINT "computer_revoked_at_check" CHECK("computer"."revoked_at" is null or (typeof("computer"."revoked_at") = 'integer' and "computer"."revoked_at" >= 0)),
	CONSTRAINT "computer_revocation_actor_check" CHECK("computer"."revoked_by_owner_credential_id" is null or "computer"."revoked_at" is not null)
);
--> statement-breakpoint
INSERT INTO computer (computer_id, created_at, revoked_at, revoked_by_owner_credential_id, claimed_at,
    machine_name, workspace_name, agents_json, connection_epoch, connection_id, state, connected_at, disconnected_at)
SELECT r.computer_id, r.created_at, r.revoked_at, r.revoked_by_owner_credential_id,
    g.claimed_at, g.machine_name, g.workspace_name, g.agents_json,
    coalesce(c.connection_epoch,0), c.connection_id, c.state, c.connected_at, c.disconnected_at
FROM runtimes r LEFT JOIN runtime_registrations g USING (computer_id)
LEFT JOIN runtime_connection_state c USING (computer_id);
INSERT INTO audit_events (category,audit_id,computer_id,actor_kind,actor_id,action,details_json,recorded_at)
SELECT 'pairing',audit_id,computer_id,actor_kind,actor_id,action,details_json,recorded_at FROM runtime_pairing_audit_events;
INSERT INTO audit_events (category,audit_id,computer_id,actor_kind,actor_id,action,details_json,recorded_at,actor_ref,subject_id,outcome)
SELECT 'authentication',audit_id,project_id,actor_kind,actor_id,action,details_json,recorded_at,actor_ref,subject_id,outcome FROM authentication_audit_events;
INSERT INTO audit_events (category,audit_id,computer_id,actor_kind,actor_id,action,details_json,recorded_at,actor_ref,subject_id,outcome,service_id)
SELECT 'platform',audit_id,project_id,actor_kind,actor_id,action,details_json,recorded_at,actor_ref,subject_id,outcome,app_id FROM platform_audit_events;
DROP TABLE runtime_connection_state;
DROP TABLE `authentication_audit_events`;--> statement-breakpoint
DROP TABLE `runtimes`;--> statement-breakpoint
DROP TABLE `runtime_pairing_audit_events`;--> statement-breakpoint
DROP TABLE `runtime_registrations`;--> statement-breakpoint
DROP TABLE `machine_account_identity`;--> statement-breakpoint
DROP TABLE `platform_audit_events`;--> statement-breakpoint
ALTER TABLE machine_browser_credentials RENAME COLUMN project_id TO computer_id;
