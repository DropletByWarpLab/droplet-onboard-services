-- WARP-1255: department/team schema + usage policy models.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - DepartmentRight enum (reader, contributor, manager)
--   - DepartmentKind enum (HOUSEHOLD, DEPARTMENT, TEAM)
--   - ProvisionState enum (pending, provisioning, active, failed, archiving, archived)
--   - NcSyncState enum (pending, synced, failed, removing)
--   - Department model (top-level or team; one-level nesting via parentId)
--   - DepartmentMembership model (per-user rights per department)
--   - DepartmentShare model (audited shares on department content)
--   - UserInviteDepartment model (department rights granted by invite)
--   - UserUsagePolicy model (per-user quota, upload cap, optional LLM cap)
--   - File.departmentId column (nullable; null = personal/household)
--
-- Per the repo idiom: every CREATE uses DO $$ ... EXCEPTION WHEN duplicate_object,
-- every ALTER uses ADD COLUMN IF NOT EXISTS, idempotent on re-run.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "DepartmentRight" AS ENUM ('reader', 'contributor', 'manager');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "DepartmentKind" AS ENUM ('HOUSEHOLD', 'DEPARTMENT', 'TEAM');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ProvisionState" AS ENUM ('pending', 'provisioning', 'active', 'failed', 'archiving', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "NcSyncState" AS ENUM ('pending', 'synced', 'failed', 'removing');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Department model ──

CREATE TABLE IF NOT EXISTS "Department" (
    "id"              TEXT           NOT NULL,
    "name"            TEXT           NOT NULL,
    "slug"            TEXT           NOT NULL,
    "parentId"        TEXT,
    "description"     TEXT,
    "kind"            "DepartmentKind" NOT NULL DEFAULT 'DEPARTMENT',
    "state"           "ProvisionState" NOT NULL DEFAULT 'pending',
    "provisionError"  TEXT,
    "ncGroupRw"       TEXT,
    "ncGroupRo"       TEXT,
    "ncGroupfolderId" INTEGER,
    "quotaBytes"      BIGINT,
    "aclVersion"      INTEGER       NOT NULL DEFAULT 0,
    "createdBy"       TEXT          NOT NULL,
    "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)  NOT NULL,
    "archivedAt"      TIMESTAMP(3),

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Department_name_key" ON "Department"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Department_slug_key" ON "Department"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "Department_ncGroupRw_key" ON "Department"("ncGroupRw");
CREATE UNIQUE INDEX IF NOT EXISTS "Department_ncGroupRo_key" ON "Department"("ncGroupRo");
CREATE UNIQUE INDEX IF NOT EXISTS "Department_ncGroupfolderId_key" ON "Department"("ncGroupfolderId");
CREATE INDEX IF NOT EXISTS "Department_state_idx" ON "Department"("state");
CREATE INDEX IF NOT EXISTS "Department_parentId_idx" ON "Department"("parentId");

-- Foreign key for self-relation (parent department)
DO $$ BEGIN
    ALTER TABLE "Department"
        ADD CONSTRAINT "Department_parentId_fkey"
        FOREIGN KEY ("parentId")
        REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── DepartmentMembership model ──

CREATE TABLE IF NOT EXISTS "DepartmentMembership" (
    "id"               TEXT           NOT NULL,
    "departmentId"     TEXT           NOT NULL,
    "userId"           TEXT           NOT NULL,
    "right"            "DepartmentRight" NOT NULL DEFAULT 'contributor',
    "syncState"        "NcSyncState"  NOT NULL DEFAULT 'pending',
    "syncError"        TEXT,
    "ncPermissionMask" INTEGER,
    "grantedBy"        TEXT           NOT NULL,
    "grantedAt"        TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DepartmentMembership_departmentId_fkey"
        FOREIGN KEY ("departmentId")
        REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DepartmentMembership_userId_fkey"
        FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DepartmentMembership_departmentId_userId_key"
    ON "DepartmentMembership"("departmentId", "userId");
CREATE INDEX IF NOT EXISTS "DepartmentMembership_userId_idx" ON "DepartmentMembership"("userId");
CREATE INDEX IF NOT EXISTS "DepartmentMembership_syncState_idx" ON "DepartmentMembership"("syncState");

-- ── DepartmentShare model ──

CREATE TABLE IF NOT EXISTS "DepartmentShare" (
    "id"           TEXT          NOT NULL,
    "departmentId" TEXT          NOT NULL,
    "ncShareId"    INTEGER       NOT NULL,
    "createdById"  TEXT          NOT NULL,
    "shareType"    INTEGER       NOT NULL,
    "path"         TEXT          NOT NULL,
    "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"    TIMESTAMP(3),

    CONSTRAINT "DepartmentShare_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DepartmentShare_departmentId_fkey"
        FOREIGN KEY ("departmentId")
        REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DepartmentShare_ncShareId_key" ON "DepartmentShare"("ncShareId");
CREATE INDEX IF NOT EXISTS "DepartmentShare_createdById_idx" ON "DepartmentShare"("createdById");

-- ── UserInviteDepartment model ──

CREATE TABLE IF NOT EXISTS "UserInviteDepartment" (
    "id"           TEXT           NOT NULL,
    "inviteId"     TEXT           NOT NULL,
    "departmentId" TEXT           NOT NULL,
    "right"        "DepartmentRight" NOT NULL DEFAULT 'contributor',

    CONSTRAINT "UserInviteDepartment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserInviteDepartment_inviteId_fkey"
        FOREIGN KEY ("inviteId")
        REFERENCES "UserInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserInviteDepartment_departmentId_fkey"
        FOREIGN KEY ("departmentId")
        REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserInviteDepartment_inviteId_departmentId_key"
    ON "UserInviteDepartment"("inviteId", "departmentId");

-- ── UserUsagePolicy model ──

CREATE TABLE IF NOT EXISTS "UserUsagePolicy" (
    "userId"              TEXT          NOT NULL,
    "storageQuotaBytes"   BIGINT,
    "quotaSyncState"      "NcSyncState" NOT NULL DEFAULT 'pending',
    "maxUploadSizeMb"     INTEGER,
    "llmDailyMessageCap"  INTEGER,
    "updatedBy"           TEXT          NOT NULL,
    "updatedAt"           TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "UserUsagePolicy_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserUsagePolicy_userId_fkey"
        FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── File model additions ──

ALTER TABLE "File"
    ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

CREATE INDEX IF NOT EXISTS "File_departmentId_idx" ON "File"("departmentId");
