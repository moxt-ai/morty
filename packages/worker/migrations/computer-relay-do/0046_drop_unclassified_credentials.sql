-- Credentials that never received a kind, or whose browser facts contradict their kind, authorize nothing: the Worker
-- has always answered them as unknown. Earlier Morty identities are unsupported, so they are removed rather than kept.
DELETE FROM `anonymous_credential`
WHERE `kind` IS NULL
    OR `kind` NOT IN ('local', 'browser', 'recovery')
    OR (`kind` = 'browser') != (`remote_transfer_id` IS NOT NULL);
