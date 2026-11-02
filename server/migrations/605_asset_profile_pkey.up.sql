-- Idempotent re-run guard: deployments that applied this series under its
-- original 593-597 numbers already carry the constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'asset_profile_pkey'
    ) THEN
        ALTER TABLE asset_profile ADD CONSTRAINT asset_profile_pkey
            PRIMARY KEY USING INDEX asset_profile_id_uidx;
    END IF;
END
$$;
