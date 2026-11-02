-- Credentials saved before every credential had a kind, but issued through a link, are browser credentials.
UPDATE `anonymous_credential` SET `kind` = 'browser' WHERE `kind` IS NULL AND `remote_transfer_id` IS NOT NULL;
--> statement-breakpoint
-- A browser was named by the first credential it held, which named no other browser; that joining describes it.
INSERT OR IGNORE INTO `browser_device` (`id`, `user_id`, `joined_at`, `label`, `joined_through_transfer_id`)
SELECT `id`, `user_id`, `created_at`, `device_label`, `remote_transfer_id`
FROM `anonymous_credential`
WHERE `kind` = 'browser' AND `browser_id` IS NULL;
--> statement-breakpoint
UPDATE `anonymous_credential` SET `device_id` = coalesce(`browser_id`, `id`) WHERE `kind` = 'browser';
