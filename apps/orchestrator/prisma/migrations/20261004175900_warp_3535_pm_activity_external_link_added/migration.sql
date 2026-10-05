-- WARP-3535 (ADR-069 §9, WS-18): PmActivityVerb gains `external_link_added` —
-- written once on a work item when a pull request, commit or branch from GitHub
-- or GitLab is linked to it because its text names the item's key.
--
-- Its OWN migration, deliberately, ordered BEFORE 20261004180000_warp_3535_pm_
-- external_links: Postgres refuses to USE a new enum value in the transaction
-- that added it, and Prisma applies a migration file inside one transaction, so
-- the value lands alone and anything that names it comes later. Same shape as
-- 20261004155900_warp_3532_work_integrations_channel: the ADD VALUE is guarded
-- by a pg_enum catalog check because re-adding an existing value errors.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'external_link_added'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'external_link_added';
    END IF;
END $$;
