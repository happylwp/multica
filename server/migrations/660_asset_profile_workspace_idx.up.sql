-- Tenant listing path: every read is scoped by workspace_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_profile_workspace_idx
    ON asset_profile (workspace_id);
