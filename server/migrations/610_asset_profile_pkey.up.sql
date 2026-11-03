-- Idempotent re-run guard: deployments that applied this series under an
-- earlier number (593-597, 598-602, or 603-607) already carry the constraint.
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
