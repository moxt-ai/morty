CREATE TABLE `session_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text
);
