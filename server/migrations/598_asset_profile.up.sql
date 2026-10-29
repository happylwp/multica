-- Asset profiles: workspace-level structured portfolio archives. Holds
-- position snapshots (funds, shares, cost, plans, rules) as a JSONB document
-- that agents, autopilots and the CLI read/write as the single source of
-- truth for portfolio reviews. Deliberately a document, not per-holding
-- rows: holdings are read and written whole, never queried field-by-field.
--
-- No FK to workspace/"user" by design (repository DB rules); readers join
-- current members and writers resolve membership in handlers. Indexes are
-- built concurrently in 599-602, following member_delegation_day (589-591),
-- so no migration below builds an index inline.
--
-- Originally shipped as 593; renumbered past the upstream 593/594 pair after
-- a sync, so deployments that already applied the old numbers replay this
-- file — hence the idempotent guard.
CREATE TABLE IF NOT EXISTS asset_profile (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL DEFAULT '{}',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
