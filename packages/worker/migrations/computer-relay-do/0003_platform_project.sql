CREATE TABLE platform_project_mapping (
    user_id TEXT NOT NULL,
    platform_origin TEXT NOT NULL,
    app_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, platform_origin, app_id),
    UNIQUE (platform_origin, project_id)
);
