-- A Project identity owns exactly one Machine. Keep the Machine bound to a Runtime, else the first one created, and
-- delete every other Machine with the conversations it owned.
DELETE FROM `managed_bot`
WHERE `bot_id` <> (
    SELECT `kept`.`bot_id` FROM `managed_bot` AS `kept`
    WHERE `kept`.`user_id` = `managed_bot`.`user_id`
    ORDER BY `kept`.`runtime_id` IS NULL, `kept`.`created_at`, `kept`.`bot_id`
    LIMIT 1
);
--> statement-breakpoint
DELETE FROM `chat_managed_session` WHERE `bot_id` NOT IN (SELECT `bot_id` FROM `managed_bot`);
