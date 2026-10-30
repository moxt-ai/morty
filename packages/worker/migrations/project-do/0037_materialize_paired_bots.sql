-- Bots created through a consumed pairing ticket existed only as that ticket until their first
-- configuration. Store them as unconfigured managed bots before the ticket table is dropped.
INSERT OR IGNORE INTO `managed_bot` (`user_id`, `bot_id`, `display_name`, `runtime_id`, `instructions`, `created_at`, `updated_at`)
SELECT `user_id`, `bot_id`, 'My Machine', NULL, '', `consumed_at`, `consumed_at`
FROM `agent_pairing_ticket`
WHERE `creates_bot` = 1 AND `consumed_at` IS NOT NULL;
