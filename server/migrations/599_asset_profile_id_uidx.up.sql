-- Primary-key index for asset_profile, built concurrently before the
-- constraint itself is attached in 600 (see member_delegation_day 590/591).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS asset_profile_id_uidx
    ON asset_profile (id);
