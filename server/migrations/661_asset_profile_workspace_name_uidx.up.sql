-- Mirror of skill's UNIQUE(workspace_id, name): profile names are unique per
-- workspace so agents can look up "the" portfolio archive by name; handler
-- maps violations to 409.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS asset_profile_workspace_name_uidx
    ON asset_profile (workspace_id, name);
