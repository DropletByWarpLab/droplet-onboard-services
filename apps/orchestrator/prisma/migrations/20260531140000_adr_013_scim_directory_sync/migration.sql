-- ADR-013 (SCIM directory sync): Okta pushes users + groups to the box via a
-- SCIM 2.0 server (/scim/v2/Users, /scim/v2/Groups). This migration adds the
-- persistence that provisioning needs. It does NOT add an "SsoConnection"-style
-- table: the SCIM provisioning bearer token + Okta OIDC config live in env
-- (config.ts DROPLET_SCIM_BEARER_TOKEN / DROPLET_SSO_OKTA_*), never the DB. The
-- SCIM identity link reuses the existing "SsoIdentity" table (provider='okta',
-- subject = the SCIM resource id) — no new identity table.
--
-- Three additive changes:
--
--   1. "DirectoryUserStatus" enum (ACTIVE | DEACTIVATED) — soft-deactivation
--      lifecycle for a directory user. Explicit enum, NOT a NULL/row-delete:
--      SCIM `active:false` / DELETE sets DEACTIVATED (the row + hash are
--      retained for audit + re-activate), and the login route + SSO callback
--      fail closed on it.
--
--   2. "User"."directoryStatus" column, DEFAULT 'ACTIVE'. The default
--      backfills every existing row to ACTIVE as part of ADD COLUMN — there is
--      NO separate UPDATE and existing credentials/rows are otherwise
--      untouched (same greenfield posture as the ADR-013 directory + SSO
--      migrations).
--
--   3. "ScimGroup" table — a group Okta pushed, with its mapped local Role.
--      Persisted so role mapping is idempotent across Okta's retries and
--      survives restarts. UNIQUE("displayName") and UNIQUE("externalId") so a
--      retry upserts the same row rather than forking duplicates.
--
-- GREENFIELD + idempotent: a DO-guarded CREATE TYPE, ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE/INDEX IF NOT EXISTS. Re-running on a converged DB is a no-op
-- (verified by applying twice in dev). No UPDATE against existing "User" rows.

-- 1. Enum — guarded because Postgres has no `CREATE TYPE IF NOT EXISTS`.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DirectoryUserStatus') THEN
        CREATE TYPE "DirectoryUserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');
    END IF;
END $$;

-- 2. Soft-deactivation column. The DEFAULT backfills existing rows to ACTIVE
--    at ADD COLUMN time — no separate UPDATE, no risk to existing data.
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "directoryStatus" "DirectoryUserStatus" NOT NULL DEFAULT 'ACTIVE';

-- 3. SCIM group → local-role registry.
CREATE TABLE IF NOT EXISTS "ScimGroup" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT NOT NULL,
    "mappedRole" "Role" NOT NULL DEFAULT 'family',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScimGroup_externalId_key"
    ON "ScimGroup"("externalId");

CREATE UNIQUE INDEX IF NOT EXISTS "ScimGroup_displayName_key"
    ON "ScimGroup"("displayName");

CREATE INDEX IF NOT EXISTS "ScimGroup_mappedRole_idx"
    ON "ScimGroup"("mappedRole");
