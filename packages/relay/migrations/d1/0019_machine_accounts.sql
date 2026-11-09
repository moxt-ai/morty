ALTER TABLE `platform_project_session_access_revocations` RENAME TO `machine_access_revocations`;--> statement-breakpoint
ALTER TABLE `platform_projects` RENAME TO `machine_accounts`;--> statement-breakpoint
ALTER TABLE `platform_app_credential_scopes` RENAME TO `machine_account_grants`;--> statement-breakpoint
ALTER TABLE `platform_dashboard_audit_events` RENAME TO `service_audit_events`;--> statement-breakpoint
ALTER TABLE `platform_app_credentials` RENAME TO `service_credentials`;--> statement-breakpoint
ALTER TABLE `machine_access_revocations` RENAME COLUMN "project_id" TO "account_id";--> statement-breakpoint
ALTER TABLE `machine_accounts` RENAME COLUMN "project_id" TO "account_id";--> statement-breakpoint
ALTER TABLE `machine_accounts` RENAME COLUMN "app_id" TO "service_id";--> statement-breakpoint
ALTER TABLE `machine_account_grants` RENAME COLUMN "project_id" TO "account_id";--> statement-breakpoint
ALTER TABLE `service_audit_events` RENAME COLUMN "app_id" TO "service_id";--> statement-breakpoint
ALTER TABLE `service_audit_events` RENAME COLUMN "project_id" TO "account_id";--> statement-breakpoint
ALTER TABLE `service_credentials` RENAME COLUMN "app_id" TO "service_id";--> statement-breakpoint
ALTER TABLE `service_credentials` RENAME COLUMN "all_projects" TO "all_accounts";--> statement-breakpoint
DROP TABLE `platform_apps`;--> statement-breakpoint
DROP TABLE `platform_app_session_status_webhooks`;--> statement-breakpoint
DROP TABLE `platform_organization_invite_links`;--> statement-breakpoint
DROP TABLE `platform_tenants`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`display_name` text NOT NULL,
	`client_reference` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`lifecycle` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`location_hint` text DEFAULT 'apac' NOT NULL,
	CONSTRAINT "machine_accounts_lifecycle_check" CHECK("__new_machine_accounts"."lifecycle" in ('active', 'deleted')),
	CONSTRAINT "machine_accounts_location_hint_check" CHECK("__new_machine_accounts"."location_hint" in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'))
);
--> statement-breakpoint
INSERT INTO `__new_machine_accounts`("account_id", "service_id", "display_name", "client_reference", "idempotency_key", "lifecycle", "created_at", "updated_at", "deleted_at", "location_hint") SELECT "account_id", "service_id", "display_name", "client_reference", "idempotency_key", "lifecycle", "created_at", "updated_at", "deleted_at", "location_hint" FROM `machine_accounts`;--> statement-breakpoint
DROP TABLE `machine_accounts`;--> statement-breakpoint
ALTER TABLE `__new_machine_accounts` RENAME TO `machine_accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `machine_accounts_service` ON `machine_accounts` (`service_id`,`lifecycle`,`created_at`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_accounts_service_id_idempotency_key_unique` ON `machine_accounts` (`service_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `machine_accounts_service_id_client_reference_unique` ON `machine_accounts` (`service_id`,`client_reference`);--> statement-breakpoint
CREATE TABLE `__new_machine_account_grants` (
	`credential_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`credential_id`, `account_id`)
);
--> statement-breakpoint
INSERT INTO `__new_machine_account_grants`("credential_id", "account_id", "created_at") SELECT "credential_id", "account_id", "created_at" FROM `machine_account_grants`;--> statement-breakpoint
DROP TABLE `machine_account_grants`;--> statement-breakpoint
ALTER TABLE `__new_machine_account_grants` RENAME TO `machine_account_grants`;--> statement-breakpoint
CREATE TABLE `__new_service_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`account_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`outcome` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "service_audit_events_project_id_check" CHECK("__new_service_audit_events"."account_id" = ''),
	CONSTRAINT "service_audit_events_outcome_check" CHECK("__new_service_audit_events"."outcome" in ('succeeded', 'denied'))
);
--> statement-breakpoint
INSERT INTO `__new_service_audit_events`("audit_id", "service_id", "account_id", "actor_kind", "actor_id", "actor_ref", "action", "subject_id", "outcome", "details_json", "recorded_at") SELECT "audit_id", "service_id", "account_id", "actor_kind", "actor_id", "actor_ref", "action", "subject_id", "outcome", "details_json", "recorded_at" FROM `service_audit_events`;--> statement-breakpoint
DROP TABLE `service_audit_events`;--> statement-breakpoint
ALTER TABLE `__new_service_audit_events` RENAME TO `service_audit_events`;--> statement-breakpoint
CREATE INDEX `service_audit_events_service` ON `service_audit_events` (`service_id`,`recorded_at`,`audit_id`);--> statement-breakpoint
CREATE TABLE `__new_service_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`public_credential_id` text NOT NULL,
	`service_id` text NOT NULL,
	`secret_digest` text NOT NULL,
	`permissions_json` text NOT NULL,
	`all_accounts` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`overlap_ends_at` integer,
	`replaced_by_credential_id` text,
	`revoked_at` integer,
	CONSTRAINT "service_credentials_all_projects_check" CHECK("__new_service_credentials"."all_accounts" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_service_credentials`("credential_id", "public_credential_id", "service_id", "secret_digest", "permissions_json", "all_accounts", "issued_at", "overlap_ends_at", "replaced_by_credential_id", "revoked_at") SELECT "credential_id", "public_credential_id", "service_id", "secret_digest", "permissions_json", "all_accounts", "issued_at", "overlap_ends_at", "replaced_by_credential_id", "revoked_at" FROM `service_credentials`;--> statement-breakpoint
DROP TABLE `service_credentials`;--> statement-breakpoint
ALTER TABLE `__new_service_credentials` RENAME TO `service_credentials`;--> statement-breakpoint
CREATE UNIQUE INDEX `service_credentials_public_credential_id_unique` ON `service_credentials` (`public_credential_id`);--> statement-breakpoint
CREATE INDEX `service_credentials_lookup` ON `service_credentials` (`public_credential_id`,`revoked_at`,`overlap_ends_at`);--> statement-breakpoint
CREATE INDEX `service_credentials_app` ON `service_credentials` (`service_id`,`issued_at`,`credential_id`);