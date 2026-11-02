-- Projects stored the time through which their Session credentials were revoked, the revocation time plus the 5 second
-- clock margin; the margin now applies when a credential is checked.
INSERT INTO `platform_project_session_access_revocations` (`project_id`, `revoked_at`)
SELECT `project_id`, `session_access_revoked_through` - 5000 FROM `platform_projects` WHERE `session_access_revoked_through` > 0;
