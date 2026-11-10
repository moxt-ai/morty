-- The machine's own and recovery credentials are revoked; browser credentials are replaced and end with their device.
INSERT INTO `owner_credential` (`id`, `user_id`, `token_hash`, `kind`, `created_at`, `revoked_at`)
SELECT `id`, `user_id`, `token_hash`, `kind`, `created_at`, `revoked_at`
FROM `anonymous_credential`
WHERE `kind` IN ('local', 'recovery');
--> statement-breakpoint
INSERT INTO `browser_credential` (`id`, `user_id`, `token_hash`, `device_id`, `transfer_id`, `created_at`, `replaced_at`)
SELECT `id`, `user_id`, `token_hash`, `device_id`, `remote_transfer_id`, `created_at`, `replaced_at`
FROM `anonymous_credential`
WHERE `kind` = 'browser';
