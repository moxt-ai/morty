-- A revoked browser credential meant either that a newer credential of the same device replaced it or that the
-- device's access ended. A device none of whose credentials is unrevoked ended when its last credential was revoked.
UPDATE `browser_device`
SET `ended_at` = (
    SELECT max(`revoked_at`) FROM `anonymous_credential` WHERE `anonymous_credential`.`device_id` = `browser_device`.`id`
)
WHERE NOT EXISTS (
    SELECT 1 FROM `anonymous_credential`
    WHERE `anonymous_credential`.`device_id` = `browser_device`.`id` AND `anonymous_credential`.`revoked_at` IS NULL
);
--> statement-breakpoint
-- Any other revoked browser credential was replaced by a newer credential of its device.
UPDATE `anonymous_credential`
SET `replaced_at` = `revoked_at`
WHERE `kind` = 'browser'
    AND `revoked_at` IS NOT NULL
    AND `device_id` NOT IN (SELECT `id` FROM `browser_device` WHERE `ended_at` IS NOT NULL);
--> statement-breakpoint
-- A browser credential's access ends with its device, never on its own.
UPDATE `anonymous_credential` SET `revoked_at` = NULL WHERE `kind` = 'browser';
