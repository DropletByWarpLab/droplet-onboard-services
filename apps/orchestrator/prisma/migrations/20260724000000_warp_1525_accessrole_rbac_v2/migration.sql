-- WARP-1525 / ADR-032: RBAC v2 T1 — AccessRole + per-axis grant tables +
-- accessRoleId columns on User and UserInvite.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - FeatureAccessLevel enum (view, act, manage)
--   - ToolAccessLevel enum (view, use)
--   - ConnectorAccessLevel enum (read, read_write)
--   - AccessExceptionEffect enum (allow, deny)
--   - AccessRole model (admin-authored custom role; startingPoint IS the
--     built-in tier its people receive — the admin|family|guest constraint is
--     SERVICE-layer (T3), deliberately NOT a DB CHECK)
--   - AccessRoleFeatureGrant model (axis a+b; PK roleId+moduleId; reuses the
--     App-Modules ModuleId enum — one feature vocabulary, no drift)
--   - AccessRoleToolGrant model (axis d on-box; PK roleId+domain; domain is
--     TEXT because tools-core's ToolDomain is TS-only, not a pgEnum)
--   - AccessRoleConnectorGrant model (axis d off-box; PK roleId+provider)
--   - UserAccessException model (per-person feature-axis exceptions, v1)
--   - User.accessRoleId column (nullable; FK ON DELETE RESTRICT — deleting an
--     in-use role must never silently strip a person's assignment; the
--     service layer blocks it with "reassign first" and the DB backs that up)
--   - UserInvite.accessRoleId column (nullable; FK ON DELETE RESTRICT — the
--     restrict applies to ANY invite row referencing the role, pending or
--     accepted/revoked/expired alike, since invite rows are retained state
--     (acceptedAt/revokedAt columns, never deleted); an invitee's intended
--     access must never silently degrade)
-- Grant/exception rows CASCADE with their role/user (they are composition).
--
-- No data backfill, nothing destructive, no seeds.
--
-- Per the repo idiom: every CREATE uses DO $$ ... EXCEPTION WHEN duplicate_object
-- or IF NOT EXISTS, every ALTER uses ADD COLUMN IF NOT EXISTS, idempotent on re-run.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "FeatureAccessLevel" AS ENUM ('view', 'act', 'manage');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ToolAccessLevel" AS ENUM ('view', 'use');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ConnectorAccessLevel" AS ENUM ('read', 'read_write');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "AccessExceptionEffect" AS ENUM ('allow', 'deny');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── AccessRole model ──

CREATE TABLE IF NOT EXISTS "AccessRole" (
    "id"                 TEXT         NOT NULL,
    "name"               TEXT         NOT NULL,
    "slug"               TEXT         NOT NULL,
    "description"        TEXT,
    "startingPoint"      "Role"       NOT NULL,
    "state"              TEXT         NOT NULL DEFAULT 'active',
    "storageQuotaBytes"  BIGINT,
    "maxUploadSizeMb"    INTEGER,
    "llmDailyMessageCap" INTEGER,
    "cloudModelsAllowed" BOOLEAN      NOT NULL DEFAULT false,
    "mayOperateLocks"    BOOLEAN      NOT NULL DEFAULT false,
    "createdBy"          TEXT         NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccessRole_slug_key" ON "AccessRole"("slug");

-- ── AccessRoleFeatureGrant model ──

CREATE TABLE IF NOT EXISTS "AccessRoleFeatureGrant" (
    "roleId"   TEXT                 NOT NULL,
    "moduleId" "ModuleId"           NOT NULL,
    "level"    "FeatureAccessLevel" NOT NULL,

    CONSTRAINT "AccessRoleFeatureGrant_pkey" PRIMARY KEY ("roleId", "moduleId"),
    CONSTRAINT "AccessRoleFeatureGrant_roleId_fkey"
        FOREIGN KEY ("roleId")
        REFERENCES "AccessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── AccessRoleToolGrant model ──

CREATE TABLE IF NOT EXISTS "AccessRoleToolGrant" (
    "roleId" TEXT              NOT NULL,
    "domain" TEXT              NOT NULL,
    "level"  "ToolAccessLevel" NOT NULL,

    CONSTRAINT "AccessRoleToolGrant_pkey" PRIMARY KEY ("roleId", "domain"),
    CONSTRAINT "AccessRoleToolGrant_roleId_fkey"
        FOREIGN KEY ("roleId")
        REFERENCES "AccessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── AccessRoleConnectorGrant model ──

CREATE TABLE IF NOT EXISTS "AccessRoleConnectorGrant" (
    "roleId"   TEXT                   NOT NULL,
    "provider" TEXT                   NOT NULL,
    "level"    "ConnectorAccessLevel" NOT NULL,

    CONSTRAINT "AccessRoleConnectorGrant_pkey" PRIMARY KEY ("roleId", "provider"),
    CONSTRAINT "AccessRoleConnectorGrant_roleId_fkey"
        FOREIGN KEY ("roleId")
        REFERENCES "AccessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── UserAccessException model ──

CREATE TABLE IF NOT EXISTS "UserAccessException" (
    "id"        TEXT                    NOT NULL,
    "userId"    TEXT                    NOT NULL,
    "moduleId"  "ModuleId"              NOT NULL,
    "effect"    "AccessExceptionEffect" NOT NULL,
    "level"     "FeatureAccessLevel",
    "grantedBy" TEXT                    NOT NULL,
    "createdAt" TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAccessException_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserAccessException_userId_fkey"
        FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserAccessException_userId_moduleId_key"
    ON "UserAccessException"("userId", "moduleId");

-- ── User model additions ──

ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "accessRoleId" TEXT;

CREATE INDEX IF NOT EXISTS "User_accessRoleId_idx" ON "User"("accessRoleId");

-- Foreign key added OUTSIDE the CREATE TABLE IF NOT EXISTS blocks (the table
-- pre-exists), so it needs its own duplicate_object guard (the WARP-1255 /
-- PR #981 lesson).
DO $$ BEGIN
    ALTER TABLE "User"
        ADD CONSTRAINT "User_accessRoleId_fkey"
        FOREIGN KEY ("accessRoleId")
        REFERENCES "AccessRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── UserInvite model additions ──

ALTER TABLE "UserInvite"
    ADD COLUMN IF NOT EXISTS "accessRoleId" TEXT;

DO $$ BEGIN
    ALTER TABLE "UserInvite"
        ADD CONSTRAINT "UserInvite_accessRoleId_fkey"
        FOREIGN KEY ("accessRoleId")
        REFERENCES "AccessRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
