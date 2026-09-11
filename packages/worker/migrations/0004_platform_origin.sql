UPDATE platform_project_mapping
SET platform_origin = CASE platform_origin
    WHEN 'https://mobius-platform.paradev.biz' THEN 'https://mobius.paradev.biz'
    WHEN 'https://mobius-platform.paraflow.biz' THEN 'https://mobius.paraflow.biz'
END
WHERE platform_origin IN (
    'https://mobius-platform.paradev.biz',
    'https://mobius-platform.paraflow.biz'
);
