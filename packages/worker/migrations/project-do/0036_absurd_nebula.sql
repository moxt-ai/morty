CREATE TABLE `chat_session_ownership` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`, `bot_id`, `session_id`)
);
