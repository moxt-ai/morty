CREATE TABLE `session_access_revocations` (
	`computer_id` text PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL,
	CONSTRAINT "session_access_revocations_revoked_at_check" CHECK(typeof("session_access_revocations"."revoked_at") = 'integer' and "session_access_revocations"."revoked_at" >= 0)
);
